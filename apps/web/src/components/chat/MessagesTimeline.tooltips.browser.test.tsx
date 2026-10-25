import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { Tooltip, TooltipTrigger, TooltipPopup, TooltipScrollDismissArea } from "../ui/tooltip";
import "~/index.css";
vi.mock("~/state/query", { spy: true });
const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
it.each([
  "hover",
  "delayed hover",
  "focus",
  "hover then focus",
  "outside timeline",
  "wheel without scroll",
  "pr hover",
  "pr delayed hover",
  "pr focus",
  "pr hover then focus",
])("handles %s through the real tooltip interactions", async (scenario) => {
  const isPullRequest = scenario.startsWith("pr ");
  const interaction = isPullRequest ? scenario.slice(3) : scenario;
  const onMouseEnter = vi.fn();
  const query = await import("~/state/query");
  using _querySpy = isPullRequest
    ? vi.spyOn(query, "useEnvironmentQuery").mockReturnValue({
        data: null,
        dataUpdatedAt: 0,
        error: "Pull request not found",
        failure: null,
        isPending: false,
        isSuccess: false,
        refresh: vi.fn(),
      })
    : { [Symbol.dispose]() {} };
  const { PullRequestLinkPreview } = await import("../pullRequest/PullRequestLinkPreview");
  const tooltip = isPullRequest ? (
    <PullRequestLinkPreview
      link={<button onMouseEnter={onMouseEnter}>message link</button>}
      originalUrl="https://example.com"
      target={{
        environmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "pingdotgg/t3code",
          number: 1,
        },
      }}
    />
  ) : (
    <Tooltip>
      <TooltipTrigger delay={50} onMouseEnter={onMouseEnter}>
        message link
      </TooltipTrigger>
      <TooltipPopup>https://example.com</TooltipPopup>
    </Tooltip>
  );
  await using screen = await render(
    <>
      <TooltipScrollDismissArea>
        <div data-testid="scrollable">{interaction === "outside timeline" ? null : tooltip}</div>
      </TooltipScrollDismissArea>
      {interaction === "outside timeline" ? tooltip : null}
    </>,
  );
  using _timers = fakeTimers();
  const container = screen.container;
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  const scrollable = container.querySelector<HTMLElement>('[data-testid="scrollable"]')!;
  await act(async () => {
    if (interaction !== "focus") {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter"));
      trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    }
    if (interaction === "focus" || interaction === "hover then focus") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      trigger.focus();
    }
    if (interaction !== "delayed hover") {
      await vi.advanceTimersByTimeAsync(isPullRequest ? 400 : 60);
    }
  });
  expect(onMouseEnter).toHaveBeenCalledTimes(interaction === "focus" ? 0 : 1);
  expect(
    document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null,
  ).toBe(interaction === "delayed hover" ? null : "https://example.com");

  await act(async () => {
    scrollable.dispatchEvent(
      interaction === "wheel without scroll"
        ? new WheelEvent("wheel", { bubbles: true, deltaY: 100 })
        : new Event("scroll"),
    );
    await vi.advanceTimersByTimeAsync(isPullRequest ? 1000 : 100);
  });
  expect(
    document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null,
  ).toBe(interaction === "hover" || interaction === "delayed hover" ? null : "https://example.com");
  if (interaction === "focus" || interaction === "hover then focus") {
    expect(document.activeElement).toBe(trigger);
  }
});
