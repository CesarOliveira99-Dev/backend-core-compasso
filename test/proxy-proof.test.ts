import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifiedProxyVisitor,
  authenticationMutation,
} from "../dist/core/application/proxy-proof.js";
const secret = "test-only-proxy-secret-0123456789abcdef",
  now = 1800000000000,
  id = "v1:" + "a".repeat(64),
  time = String(now),
  method = "GET",
  path = "/v1/auth/me";
const signature = createHmac("sha256", secret)
  .update(`proxy-v1\n${time}\n${method}\n${path}\n${id}`)
  .digest("hex");
test("proxy claims are signed, time bounded and bound to method and full request target", () => {
  const proof = { id, time, signature };
  assert.equal(verifiedProxyVisitor(proof, method, path, secret, now), id);
  for (const change of [
    { id: "v1:" + "b".repeat(64) },
    { time: String(now - 31000) },
    { signature: "0".repeat(64) },
    { signature: undefined },
  ])
    assert.equal(
      verifiedProxyVisitor({ ...proof, ...change }, method, path, secret, now),
      undefined,
    );
  assert.equal(
    verifiedProxyVisitor(proof, "POST", path, secret, now),
    undefined,
  );
  assert.equal(
    verifiedProxyVisitor(proof, method, path + "?other=1", secret, now),
    undefined,
  );
  assert.equal(
    verifiedProxyVisitor(proof, method, path, undefined, now),
    undefined,
  );
  assert.equal(
    verifiedProxyVisitor(proof, method, path, "short", now),
    undefined,
  );
});
test("read-only auth metadata does not share the mutation allowance", () => {
  assert.equal(authenticationMutation("/v1/auth/me", "GET"), false);
  assert.equal(authenticationMutation("/v1/auth/discovery", "GET"), false);
  assert.equal(authenticationMutation("/v1/auth/login", "POST"), true);
  assert.equal(authenticationMutation("/v1/auth/register", "POST"), true);
});
