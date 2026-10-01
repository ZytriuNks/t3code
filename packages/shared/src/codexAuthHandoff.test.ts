import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  codexAuthorizationRequest,
  codexAuthDeliveryUrl,
  codexAuthHandoffUrl,
  readCodexAuthDelivery,
  readCodexAuthHandoff,
} from "./codexAuthHandoff.ts";

const authorizationUrl = () => {
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:54213/auth/callback",
    state: "a".repeat(43),
    code_challenge_method: "S256",
    code_challenge: "b".repeat(43),
  }).toString();
  return url.toString();
};
const input = {
  authorizationUrl: authorizationUrl(),
  returnUrl: "https://app.t3.codes/welcome#agents:remote-environment",
  environmentId: EnvironmentId.make("remote-environment"),
  instanceId: ProviderInstanceId.make("work-codex"),
  flowId: "flow-one",
};
const callbackUrl = `http://127.0.0.1:54213/auth/callback?state=${"a".repeat(43)}&code=one-time-code&client_id=oaiapp_test`;

describe("Codex desktop handoff", () => {
  const desktopSchemes = ["t3code", "t3code-dev", "t3code-experimental"];

  it.each(desktopSchemes)("targets only the selected %s desktop handler", (scheme) => {
    const link = new URL(codexAuthHandoffUrl(input));
    link.protocol = `${scheme}:`;
    expect(codexAuthHandoffUrl(input, scheme)).toBe(link.toString());
    for (const receiver of desktopSchemes) {
      expect(readCodexAuthHandoff(link.toString(), receiver)).toEqual(
        receiver === scheme ? input : undefined,
      );
    }
  });

  it.each([
    [false, "t3code"],
    [true, "t3code-dev"],
  ] as const)("preserves the legacy development=%s handoff", (development, scheme) => {
    const link = codexAuthHandoffUrl(input, development);
    expect(new URL(link).protocol).toBe(`${scheme}:`);
    expect(readCodexAuthHandoff(link, development)).toEqual(input);
  });

  it.each(["t3code-beta", "https", "t3code-experimental:", "t3code-dev://auth/codex"])(
    "rejects unsupported desktop scheme %s even when supplied by the caller",
    (scheme) => {
      expect(() => codexAuthHandoffUrl(input, scheme)).toThrow();
      const link = new URL(codexAuthHandoffUrl(input));
      link.protocol = "t3code-beta:";
      expect(readCodexAuthHandoff(link.toString(), scheme)).toBeUndefined();
    },
  );

  it.each(desktopSchemes)(
    "delivers to the selected %s desktop without leaking the code",
    (scheme) => {
      const request = {
        ...input,
        returnUrl: `${scheme}://app/settings/providers?instanceId=work-codex&code=discard#discard`,
      };
      const delivery = codexAuthDeliveryUrl(request, callbackUrl);
      const url = new URL(delivery);
      expect(url.protocol).toBe(`${scheme}:`);
      expect(url.search).toBe("?instanceId=work-codex");
      expect(readCodexAuthDelivery(delivery)).toEqual({
        callbackUrl,
        environmentId: input.environmentId,
        instanceId: input.instanceId,
        flowId: input.flowId,
        returnHash: "",
        returnUrl: `${scheme}://app/settings/providers?instanceId=work-codex`,
      });
    },
  );

  it("keeps the hosted return route, account, and environment with the code in a fragment", () => {
    expect(readCodexAuthHandoff(codexAuthHandoffUrl(input), false)).toEqual(input);
    const delivery = codexAuthDeliveryUrl(input, callbackUrl);
    expect(new URL(delivery).search).toBe("");
    expect(readCodexAuthDelivery(delivery)).toEqual({
      callbackUrl,
      environmentId: input.environmentId,
      instanceId: input.instanceId,
      flowId: input.flowId,
      returnHash: "#agents:remote-environment",
      returnUrl: input.returnUrl,
    });
  });
  it("rejects other handlers, schemes, arbitrary return sites, and non-OpenAI authorization", () => {
    const link = codexAuthHandoffUrl(input);
    expect(readCodexAuthHandoff(link, true)).toBeUndefined();
    expect(readCodexAuthHandoff(link.replace("auth/codex", "auth/other"), false)).toBeUndefined();
    expect(
      readCodexAuthHandoff(
        codexAuthHandoffUrl({ ...input, returnUrl: "https://attacker.example/welcome" }),
        false,
      ),
    ).toBeUndefined();
    expect(
      readCodexAuthHandoff(
        codexAuthHandoffUrl({
          ...input,
          authorizationUrl: input.authorizationUrl.replace("auth.openai.com", "attacker.example"),
        }),
        false,
      ),
    ).toBeUndefined();
  });
  it("rejects duplicated authorization parameters and non-loopback callback addresses", () => {
    expect(() =>
      codexAuthorizationRequest(
        input.authorizationUrl + "&redirect_uri=http://localhost:1/auth/callback",
      ),
    ).toThrow();
    const url = new URL(input.authorizationUrl);
    url.searchParams.set("redirect_uri", "http://localhost:54213/auth/callback");
    expect(() => codexAuthorizationRequest(url.toString())).toThrow();
    url.searchParams.set("redirect_uri", "https://attacker.example/auth/callback");
    expect(() => codexAuthorizationRequest(url.toString())).toThrow();
    expect(() => codexAuthDeliveryUrl(input, callbackUrl + "&state=another")).toThrow();
  });
});
