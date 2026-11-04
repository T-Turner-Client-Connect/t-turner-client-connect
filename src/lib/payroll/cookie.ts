// The browser-bound proof that an approver confirmed their identity for one payroll link.
export const PAYROLL_VERIFY_COOKIE = process.env.NODE_ENV === "production" ? "__Host-tcc_payroll_verify" : "tcc_payroll_verify";
