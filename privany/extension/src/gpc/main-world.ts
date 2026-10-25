// Runs in the page's own JS world (only while "Send GPC" is on), so scripts on
// the page see navigator.globalPrivacyControl === true, same as PrivAudit's crawler.
try {
  Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true });
} catch {
  /* page locked it down; the Sec-GPC header still goes out */
}
