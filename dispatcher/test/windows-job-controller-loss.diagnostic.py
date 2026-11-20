"""Manual Windows diagnostic for recovering a fabricated started assignment."""

import ctypes as c
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

if os.name != "nt":
    raise SystemExit("held: this fixture requires native Windows")

SCRIPT = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("job_drain", SCRIPT.with_name("windows-job-drain.diagnostic.py"))
job_drain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job_drain)
Held = job_drain.Held
require = job_drain.require


@dataclass(frozen=True)
class JobWitness:
    group: str
    handle: int


@contextmanager
def owned_job(group):
    job = job_drain.check_os(job_drain.create_job(None, None), "create fixture job")
    try:
        require_empty(job)
        yield JobWitness(group, job)
    finally:
        job_drain.close(job)


def require_empty(job):
    require(job_drain.members(job) == 0 and not job_drain.member_ids(job), "fixture job was not empty")


def environment(fixture):
    return {"SystemRoot": os.environ["SystemRoot"], "TEMP": str(fixture / "tmp"), "TMP": str(fixture / "tmp")}


def node_command(node, fixture, role, group):
    return [str(node), "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
            str(SCRIPT.with_name("windows-job-recovery.fixture.ts")), role, str(fixture), str(os.getpid()), group]


def await_marker(path, process):
    deadline = time.monotonic() + 30
    while not path.is_file():
        require(job_drain.wait(process, 0) == job_drain.WAIT_TIMEOUT, "fixture process exited before its marker")
        require(time.monotonic() < deadline, "fixture marker wait expired")
        time.sleep(0.015)


def check_exit(process, expected):
    code = job_drain.w.DWORD()
    require(job_drain.wait(process, 15_000) == job_drain.WAIT_OBJECT_0, "fixture exit was not observed")
    job_drain.check_os(job_drain.get_exit(process, c.byref(code)), "read owned process exit")
    require(code.value == expected, "fixture exit code differed")


def check_members(job, expected, stage):
    active, listed = job_drain.members(job), job_drain.member_ids(job)
    require(active == len(expected) and listed == expected,
            f"{stage}: expected {len(expected)}, active {active}, listed {len(listed)}")


def await_late_writer(job, writer_pid, original_members):
    deadline = time.monotonic() + 15
    while True:
        listed = job_drain.member_ids(job)
        require(writer_pid in listed and listed <= original_members, "unexpected membership after controller exit")
        if listed == {writer_pid} and job_drain.members(job) == 1:
            return
        require(time.monotonic() < deadline, "controller helpers did not exit")
        time.sleep(0.015)


def snapshot(fixture):
    state = fixture / "state"
    return ((state / "assignment-intents.jsonl").read_bytes(), (state / "ledger.json").read_bytes(),
            {entry.name: entry.read_bytes() for entry in (fixture / "workspace").iterdir()})


def records(journal):
    return [json.loads(row) for row in journal.splitlines()]


def receipt(witness, intent):
    require_empty(witness.handle)
    return {"group": witness.group, "active": 0, "terminal": {
        "id": intent["id"], "sequence": intent["sequence"], "result": "completed", "writersContained": True,
    }}


def recovery(node, fixture, group, wanted, digest=None, observation=None, *, next_request=False, authorized=True):
    request = {"next": next_request, "authorized": authorized, "observation": observation}
    try:
        result = subprocess.run(node_command(node, fixture, "recover", group), cwd=fixture, env=environment(fixture),
                                input=json.dumps(request), capture_output=True, text=True, check=False,
                                close_fds=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=20)
    except subprocess.TimeoutExpired:
        raise Held("fixture recovery did not answer") from None
    require(result.returncode == 0 and not result.stderr, "fixture recovery failed")
    observed = json.loads(result.stdout)
    require(observed == {
        "result": {"state": wanted, "qualification": "unqualified-harness", "publishable": False},
        "effects": 0, "reconciliations": int(digest is not None), "readDigest": digest,
    }, "recovery result, effect count or observed intent differed")


def run_case(node, witness, fresh, foreign=None):
    with tempfile.TemporaryDirectory(prefix=job_drain.PREFIX + "controller-loss-", dir=job_drain.ROOT) as temporary:
        fixture = Path(temporary).resolve(strict=True)
        require(fixture.parent == job_drain.ROOT, "temporary path outside the owned checkout")
        workspace, control = fixture / "workspace", fixture / "control"
        for path in (workspace, control, fixture / "tmp"):
            path.mkdir()
        processes = []
        try:
            summary, evidence = run_started_case(node, fixture, witness, fresh, foreign, processes)
        finally:
            (control / "abort").touch()
            try:
                exits = [job_drain.wait(process, 15_000) for process in processes]
                require(all(result == job_drain.WAIT_OBJECT_0 for result in exits), "owned process did not exit at cleanup")
            finally:
                for process in processes:
                    job_drain.close(process)
    require(not fixture.exists(), "temporary fixture survived cleanup")
    return summary, evidence


def run_started_case(node, fixture, witness, fresh, foreign, processes):
    workspace, control = fixture / "workspace", fixture / "control"
    job, group = witness.handle, witness.group
    controller = job_drain.open_job_process(job, node_command(node, fixture, "controller", group), fixture, environment(fixture))
    processes.append(controller.process)
    job_drain.verify_member(controller.process, controller.pid, job, "assignment controller")
    await_marker(control / "controller-started", controller.process)
    controller_members = job_drain.member_ids(job)
    require(controller.pid in controller_members, "started controller was not a job member")
    before = snapshot(fixture)
    intent, started = records(before[0])
    require(intent["kind"] == "intent" and intent["pid"] == controller.pid and started["kind"] == "started"
            and all(intent[key] == started[key] for key in ("id", "sequence", "requestDigest")),
            "controller did not persist a matching started intent")
    require(json.loads(before[1])["workspace"] == {"path": str(workspace), "writerPid": controller.pid, "qualified": False}
            and before[2] == {}, "initial workspace claim differed")
    digest = intent["requestDigest"]

    writer = job_drain.open_job_process(job, job_drain.command("writer", fixture, os.getpid()), workspace, environment(fixture))
    processes.append(writer.process)
    job_drain.verify_member(writer.process, writer.pid, job, "late writer")
    await_marker(control / "writer-ready", writer.process)
    require(int((control / "writer-ready").read_text(encoding="ascii")) == writer.pid, "writer report differed")
    with_writer = controller_members | {writer.pid}
    check_members(job, with_writer, "before controller exit")
    (control / "controller-exit").touch(exist_ok=False)
    check_exit(controller.process, 73)
    job_drain.close(controller.process)
    processes.remove(controller.process)
    await_late_writer(job, writer.pid, with_writer)

    if foreign is None:
        recovery(node, fixture, group, "held", digest)
        require(snapshot(fixture) == before, "unavailable recovery changed the fixture")
        recovery(node, fixture, group, "held", digest, receipt(fresh, intent))
        require(snapshot(fixture) == before, "new empty job changed the fixture")
        recovery(node, fixture, group, "held", next_request=True)
        require(snapshot(fixture) == before, "the next request changed unresolved work")
    check_members(job, {writer.pid}, "before writer gate")
    (control / "write-once").touch(exist_ok=False)
    check_exit(writer.process, 0)
    job_drain.close(writer.process)
    processes.remove(writer.process)
    evidence = receipt(witness, intent)
    drained = (before[0], before[1], {"sentinel.txt": job_drain.SENTINEL})
    require(snapshot(fixture) == drained, "original writer did not leave exactly its authorized marker")

    if foreign is None:
        recovery(node, fixture, group, "held", digest)
        require(snapshot(fixture) == drained, "unavailable recovery changed the drained fixture")
        return {"jobCounts": [len(with_writer), 1, 0], "unavailableWhileLive": "held", "newEmptyJob": "held", "nextRequest": "held",
                "unavailableAfterDrain": "held"}, evidence

    recovery(node, fixture, group, "held", digest, foreign)
    require(snapshot(fixture) == drained, "foreign job changed the fixture")
    wrong_terminal = {**evidence, "terminal": {**evidence["terminal"], "id": "f" * 32}}
    recovery(node, fixture, group, "held", digest, wrong_terminal)
    require(snapshot(fixture) == drained, "foreign terminal changed the fixture")
    recovery(node, fixture, group, "held", observation=evidence, authorized=False)
    require(snapshot(fixture) == drained, "revoked recovery changed the fixture")
    recovery(node, fixture, group, "completed", digest, evidence)
    completed = snapshot(fixture)
    require(completed[0].startswith(before[0]) and completed[1:] == drained[1:], "terminal changed existing state")
    terminal, = records(completed[0][len(before[0]):])
    require(terminal["kind"] == "result" and terminal["outcome"] == "completed"
            and all(terminal[key] == intent[key] for key in ("id", "sequence", "requestDigest")),
            "terminal did not append exactly one matching result")
    recovery(node, fixture, group, "completed")
    require(snapshot(fixture) == completed, "terminal replay changed the fixture")
    return {"jobCounts": [len(with_writer), 1, 0], "foreignJob": "held", "foreignTerminal": "held", "revoked": "held",
            "sameJob": "completed", "replay": "completed", "terminalRecords": 1}, evidence


def main():
    require(len(sys.argv) == 1, "invoke the diagnostic without arguments")
    found = shutil.which("node.exe")
    require(found is not None, "native Node is unavailable")
    node = Path(found).resolve(strict=True)
    require(not node.is_relative_to(job_drain.ROOT), "Node must be installed outside this fixture checkout")
    with owned_job("loss-origin") as loss, owned_job("control-origin") as control, owned_job("new-empty") as fresh:
        require(len({loss.handle, control.handle, fresh.handle}) == 3, "fixture jobs were not distinct")
        held, foreign = run_case(node, loss, fresh)
        allowed, _ = run_case(node, control, fresh, foreign)
    print(json.dumps({"status": "fixture-verified", "controllerExits": [73, 73],
                      "lostHandle": held, "retainedHandle": allowed, "recoveryEffects": 0,
                      "recoveryClaims": 0, "fixturesRemoved": True}))


if __name__ == "__main__":
    try:
        main()
    except Held as error:
        print(json.dumps({"status": "held", "stage": error.stage, "winerror": error.winerror}))
        raise SystemExit(1)
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"status": "held", "stage": "fixture input or I/O was unavailable"}))
        raise SystemExit(1)
