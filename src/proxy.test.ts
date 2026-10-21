import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

function request(host: string) {
  return new NextRequest("http://127.0.0.1:3000/", { headers: { host } });
}

describe("proxy (Host allowlist on every route)", () => {
  it("lets localhost and 127.0.0.1 through", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000"]) {
      const res = proxy(request(host));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("rejects a DNS-rebinding Host with 403 and anti-framing headers", async () => {
    const res = proxy(request("rebind.attacker.example:3000"));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("localhost 또는 127.0.0.1");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });
});
