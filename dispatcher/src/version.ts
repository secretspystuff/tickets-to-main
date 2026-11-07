/** Public package version. This is not a signed release. */
export const PACKAGE_VERSION = "0.1.0";

/**
 * Device-login fixtures only. The coordination protocol is tickets-to-main.coordination
 * version 1, and its runtime is not served. This revision is not that protocol.
 */
export const PROTOCOL_REVISION = "waiting-on-t1" as const;

export const PRODUCT_LINE = "Tickets to Main";
