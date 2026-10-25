import { describe, expect, it } from "vite-plus/test";

import { webhookAddress } from "./webhookAddress.ts";

const endpoint = { path: "/fixture-hook", url: null, hasSecret: false };
const copy = { needsPublicUrl: "需要公开地址", loopback: "仅本机可达", network: "网络可达" };

describe("webhook address reachability", () => {
  it("prefers the public URL over a local base and needs no reachability warning", () => {
    expect(
      webhookAddress(
        { ...endpoint, url: "https://example.com/hook" },
        "http://localhost:1234",
        copy,
      ),
    ).toEqual({ address: "https://example.com/hook", copyable: true, note: null });
  });

  it("does not offer an incomplete relative address for copying", () => {
    expect(webhookAddress(endpoint, null, copy)).toEqual({
      address: "/fixture-hook",
      copyable: false,
      note: "需要公开地址",
    });
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "warns that %s can only be called locally",
    (host) => {
      expect(webhookAddress(endpoint, `http://${host}:1234`, copy)).toEqual({
        address: `http://${host}:1234/fixture-hook`,
        copyable: true,
        note: "仅本机可达",
      });
    },
  );

  it("keeps a reachable network address and the default English copy for other clients", () => {
    expect(webhookAddress(endpoint, "https://fixture.example.com", copy)).toEqual({
      address: "https://fixture.example.com/fixture-hook",
      copyable: true,
      note: "网络可达",
    });
    expect(webhookAddress(endpoint, null).note).toBe(
      "Link this environment to T3 Connect for a public URL.",
    );
  });
});
