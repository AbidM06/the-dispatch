/**
 * server/middleware/auth.js
 * Write-auth guard for mutating routes.
 * If DISPATCH_ADMIN_KEY env var is not set, middleware is a no-op (dev mode — open access).
 * If set, requires x-dispatch-key header to match exactly.
 */
"use strict";
module.exports = function requireWriteAuth(req, res, next) {
  const key = process.env.DISPATCH_ADMIN_KEY;
  if (!key) return next(); // dev mode: no key configured
  const provided = req.headers["x-dispatch-key"];
  if (!provided || provided !== key) {
    return res.status(401).json({ error: "Unauthorized — x-dispatch-key header required." });
  }
  next();
};
