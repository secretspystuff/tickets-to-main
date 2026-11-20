"""Offline Windows fixture. Invoke without arguments from the owned checkout."""

import ctypes as c
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes as w
from pathlib import Path

if os.name != "nt":
    raise SystemExit('held: this fixture requires native Windows')

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve()
PREFIX = "ttm-job-drain-"
SENTINEL = b"fabricated writer finished its one authorized write\n"
JOB_LIST = 13 | 0x00020000
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
JOB_BASIC_ACCOUNTING = 1
JOB_BASIC_PROCESS_IDS = 3
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x00100000
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
INFINITE = 0xFFFFFFFF

kernel = c.WinDLL("kernel32", use_last_error=True)


class StartupInfo(c.Structure):
    _fields_ = [
        ("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR), ("title", w.LPWSTR),
        ("x", w.DWORD), ("y", w.DWORD), ("width", w.DWORD), ("height", w.DWORD),
        ("columns", w.DWORD), ("rows", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
        ("show", w.WORD), ("reserved_size", w.WORD), ("reserved_bytes", c.POINTER(w.BYTE)),
        ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE),
    ]


class StartupInfoEx(c.Structure):
    _fields_ = [("info", StartupInfo), ("attributes", w.LPVOID)]


class ProcessInfo(c.Structure):
    _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]


class Accounting(c.Structure):
    _fields_ = [(name, c.c_longlong) for name in ("user_time", "kernel_time", "period_user", "period_kernel")] + [
        (name, w.DWORD) for name in ("page_faults", "total", "active", "terminated")
    ]


class JobProcessIds(c.Structure):
    _fields_ = [("assigned", w.DWORD), ("listed", w.DWORD), ("pids", c.c_size_t * 8)]


def bind(name, result, *arguments):
    call = getattr(kernel, name)
    call.restype = result
    call.argtypes = arguments
    return call


create_job = bind("CreateJobObjectW", w.HANDLE, w.LPVOID, w.LPCWSTR)
init_attributes = bind("InitializeProcThreadAttributeList", w.BOOL, w.LPVOID, w.DWORD, w.DWORD, c.POINTER(c.c_size_t))
update_attribute = bind("UpdateProcThreadAttribute", w.BOOL, w.LPVOID, w.DWORD, c.c_size_t, w.LPVOID, c.c_size_t, w.LPVOID, w.LPVOID)
delete_attributes = bind("DeleteProcThreadAttributeList", None, w.LPVOID)
create_process = bind("CreateProcessW", w.BOOL, w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL,
                      w.DWORD, w.LPVOID, w.LPCWSTR, c.POINTER(StartupInfo), c.POINTER(ProcessInfo))
query_job = bind("QueryInformationJobObject", w.BOOL, w.HANDLE, c.c_int, w.LPVOID, w.DWORD, c.POINTER(w.DWORD))
is_in_job = bind("IsProcessInJob", w.BOOL, w.HANDLE, w.HANDLE, c.POINTER(w.BOOL))
open_process = bind("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
process_id = bind("GetProcessId", w.DWORD, w.HANDLE)
wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
get_exit = bind("GetExitCodeProcess", w.BOOL, w.HANDLE, c.POINTER(w.DWORD))
close = bind("CloseHandle", w.BOOL, w.HANDLE)


class Held(Exception):
    def __init__(self, stage, winerror=None):
        self.stage = stage
        self.winerror = winerror


def require(condition, stage):
    if not condition:
        raise Held(stage)


def check_os(result, stage):
    if not result:
        raise Held(stage, c.get_last_error())
    return result


def command(role, fixture, owner):
    return [sys.executable, "-I", "-S", str(SCRIPT), role, str(fixture), str(owner)]


def open_root(job, fixture):
    return open_job_process(job, command("parent", fixture, os.getpid()), fixture / "workspace",
                            {"SystemRoot": os.environ["SystemRoot"]})


def open_job_process(job, argv, cwd, environment):
    size = c.c_size_t()
    result = init_attributes(None, 1, 0, c.byref(size))
    if result or c.get_last_error() != 122 or size.value == 0:
        raise Held("size job-list startup attributes", c.get_last_error())
    attributes = c.create_string_buffer(size.value)
    check_os(init_attributes(attributes, 1, 0, c.byref(size)), "initialize job-list startup attributes")
    try:
        jobs = (w.HANDLE * 1)(job)
        check_os(update_attribute(attributes, 0, JOB_LIST, jobs, c.sizeof(jobs), None, None),
                 "set PROC_THREAD_ATTRIBUTE_JOB_LIST")
        startup = StartupInfoEx()
        startup.info.cb = c.sizeof(startup)
        startup.attributes = c.addressof(attributes)
        info = ProcessInfo()
        args = c.create_unicode_buffer(subprocess.list2cmdline(argv))
        env_block = c.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in environment.items()) + "\0\0")
        flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | subprocess.DETACHED_PROCESS
        check_os(create_process(argv[0], args, None, None, False, flags, env_block,
                                str(cwd), c.byref(startup.info), c.byref(info)),
                 "CreateProcessW with job list")
        close(info.thread)
        return info
    finally:
        delete_attributes(attributes)


def members(job):
    data = Accounting()
    check_os(query_job(job, JOB_BASIC_ACCOUNTING, c.byref(data), c.sizeof(data), None),
             "query active processes on retained job")
    return data.active


def member_ids(job):
    data = JobProcessIds()
    check_os(query_job(job, JOB_BASIC_PROCESS_IDS, c.byref(data), c.sizeof(data), None),
             "query process identifiers on retained job")
    require(data.assigned == data.listed <= len(data.pids), "job membership list was incomplete")
    return set(data.pids[:data.listed])


def verify_member(process, pid, job, stage):
    result = w.BOOL()
    require(process_id(process) == pid, stage + " process identity")
    check_os(is_in_job(process, job, c.byref(result)), stage + " IsProcessInJob")
    require(result.value, stage + " missing membership")


def workspace_probe(node, fixture, action):
    try:
        result = subprocess.run(
            [str(node), "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
             str(SCRIPT.with_name("windows-job-claim.fixture.ts")), action, str(fixture), str(os.getpid())],
            cwd=fixture, env={"SystemRoot": os.environ["SystemRoot"],
                              "TEMP": str(fixture / "tmp"), "TMP": str(fixture / "tmp")},
            stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False,
            creationflags=subprocess.CREATE_NO_WINDOW, timeout=45,
        )
    except subprocess.TimeoutExpired:
        raise Held("workspace probe did not answer: " + action) from None
    require(result.returncode == 0, "workspace probe failed: " + action)
    try:
        payload = json.loads(result.stdout)
    except ValueError:
        raise Held("invalid workspace probe response") from None
    require(isinstance(payload, dict) and set(payload) == {"outcome"}, "invalid workspace probe response")
    return payload["outcome"]


def release_if_drained(active_members, release):
    try:
        active = active_members()
    except Held:
        return None
    if active == 0:
        require(release() == "released", "workspace release was not recorded")
    return active


def unavailable_members():
    raise Held("fabricated unavailable job query")


def natural_exit(process, stage):
    require(wait(process, INFINITE) == WAIT_OBJECT_0, stage + " wait failed")
    code = w.DWORD()
    check_os(get_exit(process, c.byref(code)), stage + " GetExitCodeProcess")
    require(code.value == 0, stage + " did not exit normally")
    return code.value


def wait_for_report(path, parent_handle):
    while not path.exists():
        require(wait(parent_handle, 0) == WAIT_TIMEOUT, "parent exited before writer reported")
        time.sleep(0.015)
    value = path.read_text(encoding="ascii")
    require(value.isdecimal() and int(value) > 0, "invalid fixture PID report")
    return int(value)


def wait_gate(control, name, owner, *, writer=None):
    while wait(owner, 0) == WAIT_TIMEOUT and not (control / "abort").exists():
        if (control / name).exists():
            return True
        if writer is not None and writer.poll() is not None:
            raise Held("writer exited before root handoff")
        time.sleep(0.015)
    return False


def publish_pid(control, name, pid):
    partial = control / (name + ".tmp")
    partial.write_text(str(pid), encoding="ascii")
    partial.rename(control / name)


def fixture_child(role, fixture_arg, controller_pid):
    fixture = Path(fixture_arg).resolve(strict=True)
    require(fixture.parent == ROOT and fixture.name.startswith(PREFIX), "fixture path outside owned tree")
    require(Path.cwd().resolve() == fixture / "workspace", "unexpected fixture cwd")
    control = fixture / "control"
    owner = check_os(open_process(SYNCHRONIZE, False, controller_pid), "open exact controller for observation")
    try:
        if role == "writer":
            publish_pid(control, "writer-ready", os.getpid())
            if wait_gate(control, "write-once", owner):
                with (fixture / "workspace" / "sentinel.txt").open("xb") as output:
                    output.write(SENTINEL)
        else:
            publish_pid(control, "root-ready", os.getpid())
            if not wait_gate(control, "start-writer", owner):
                return
            writer = subprocess.Popen(command("writer", fixture, controller_pid), cwd=Path.cwd(),
                                      env={"SystemRoot": os.environ["SystemRoot"]},
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      creationflags=subprocess.DETACHED_PROCESS)
            publish_pid(control, "writer-spawned", writer.pid)
            if not wait_gate(control, "parent-exit", owner, writer=writer):
                writer.wait()
    finally:
        close(owner)


def run_fixture(fixture, node):
    workspace = fixture / "workspace"
    control = fixture / "control"
    workspace.mkdir()
    control.mkdir()
    (fixture / "tmp").mkdir()
    sentinel = workspace / "sentinel.txt"
    ledger = fixture / "state" / "ledger.json"
    require(workspace_probe(node, fixture, "prepare") == "owner-recorded", "controller was not recorded")
    owner_receipt = ledger.read_bytes()
    require(json.loads(owner_receipt).get("workspace") == {
        "path": str(workspace.resolve(strict=True)), "writerPid": os.getpid(), "qualified": False,
    }, "ledger did not record the fixture controller")
    job = check_os(create_job(None, None), "create unnamed job")
    handles = []
    try:
        require(members(job) == 0, "new job was not empty")
        parent = open_root(job, fixture)
        handles.append(parent.process)
        verify_member(parent.process, parent.pid, job, "root before permission to start writer")
        require(wait_for_report(control / "root-ready", parent.process) == parent.pid, "root PID mismatch")
        root_members = member_ids(job)
        require(root_members == {parent.pid},
                f"root observation listed {len(root_members)}, root listed {parent.pid in root_members}, active {members(job)}")
        (control / "start-writer").touch(exist_ok=False)

        writer_pid = wait_for_report(control / "writer-spawned", parent.process)
        require(wait_for_report(control / "writer-ready", parent.process) == writer_pid, "writer PID mismatch")
        writer = check_os(open_process(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, writer_pid),
                          "open observed fixture writer")
        handles.append(writer)
        verify_member(writer, writer_pid, job, "detached writer")
        identifiers = member_ids(job)
        both_active = members(job)
        require(both_active == 2 and identifiers == {parent.pid, writer_pid},
                f"expected only root and writer, observed {both_active} active and {len(identifiers)} listed")

        (control / "parent-exit").touch(exist_ok=False)
        parent_exit = natural_exit(parent.process, "root")
        close(parent.process)
        handles.remove(parent.process)
        verify_member(writer, writer_pid, job, "writer after root exited")
        only_writer_active = members(job)
        require(only_writer_active == 1 and wait(writer, 0) == WAIT_TIMEOUT, "writer did not survive alone in the job")
        require(not sentinel.exists(), "sentinel appeared before writer release")

        def live_writer():
            active = members(job)
            require(active == 1 and member_ids(job) == {writer_pid} and wait(writer, 0) == WAIT_TIMEOUT,
                    "same job did not report the live writer")
            return active

        def release():
            return workspace_probe(node, fixture, "release")

        claims = []
        release_observations = []
        for observe, expected in ((live_writer, 1), (unavailable_members, None)):
            release_observations.append(release_if_drained(observe, release))
            require(release_observations[-1] == expected, "wrong pre-drain observation")
            claims.append(workspace_probe(node, fixture, "claim"))
            require(claims[-1] == "held", "another claimant acquired the occupied workspace")
            require(live_writer() == 1, "the observed writer did not remain active")
            require(ledger.read_bytes() == owner_receipt and not list(workspace.iterdir()),
                    "held claim changed the workspace or ledger")

        (control / "write-once").touch(exist_ok=False)
        writer_exit = natural_exit(writer, "writer")
        close(writer)
        handles.remove(writer)
        drained = members(job)
        require(drained == 0 and not member_ids(job), "same job did not drain")
        require(list(workspace.iterdir()) == [sentinel] and sentinel.read_bytes() == SENTINEL,
                "fixture did not contain exactly the expected late write")
        require(ledger.read_bytes() == owner_receipt, "ownership changed while the writer finished")
        require(release_if_drained(lambda: members(job), release) == 0, "verified drain still held the workspace")
        claims.append(workspace_probe(node, fixture, "claim"))
        require(claims == ["held", "held", "claimed"], "workspace did not transfer exactly once")
        require(list(workspace.iterdir()) == [sentinel] and sentinel.read_bytes() == SENTINEL,
                "workspace transfer changed the completed write")
        return {"status": "fixture-drained", "association": "CreateProcessW job list",
                "rootMember": True, "writerMemberAfterRootExit": True,
                "activeCounts": [both_active, only_writer_active, drained], "rootExit": parent_exit,
                "writerExit": writer_exit, "lateSentinelWrites": 1,
                "releaseObservationsBeforeDrain": release_observations,
                "claimOutcomes": claims, "heldLedgerAndWorkspacePreserved": True}
    finally:
        (control / "abort").touch()
        for handle in handles:
            wait(handle, INFINITE)
            close(handle)
        close(job)


def main():
    if len(sys.argv) == 4 and sys.argv[1] in {"parent", "writer"}:
        fixture_child(sys.argv[1], sys.argv[2], int(sys.argv[3]))
        return
    require(len(sys.argv) == 1, "invoke the diagnostic without arguments")
    found_node = shutil.which("node.exe")
    require(found_node is not None, "native Node is unavailable")
    node = Path(found_node).resolve(strict=True)
    require(not node.is_relative_to(ROOT), "Node must be installed outside this fixture checkout")
    with tempfile.TemporaryDirectory(prefix=PREFIX, dir=ROOT) as temporary:
        fixture = Path(temporary).resolve(strict=True)
        require(fixture.parent == ROOT and fixture.name.startswith(PREFIX), "temporary fixture outside owned tree")
        result = run_fixture(fixture, node)
    print(json.dumps({**result, "fixtureRemoved": not fixture.exists(), "codexInvoked": False}))


if __name__ == "__main__":
    try:
        main()
    except Held as error:
        print(json.dumps({"status": "held", "stage": error.stage, "winerror": error.winerror}))
        raise SystemExit(1)
    except (OSError, ValueError):
        print(json.dumps({"status": "held", "stage": "fixture input or I/O was unavailable"}))
        raise SystemExit(1)
