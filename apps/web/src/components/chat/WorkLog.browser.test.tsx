import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { WorkLogDetails } from "./WorkLog";
import "~/index.css";

function trace(followLive: boolean, lines: number) {
  return (
    <WorkLogDetails followLive={followLive}>
      <pre style={{ lineHeight: "20px" }}>{"Streamed trace\n".repeat(lines)}</pre>
    </WorkLogDetails>
  );
}

it("navigates the streamed trace with the compact scrollbar and resumes following at the end", async () => {
  await using screen = await render(trace(true, 50));
  const viewport = screen.container.querySelector("pre")!.parentElement!;
  const vertical = screen.container.querySelector<HTMLElement>(
    '[role="scrollbar"][aria-orientation="vertical"]',
  )!;
  await act(() => vertical.focus());
  await userEvent.keyboard("{Home}");
  await vi.waitFor(() => expect((() => viewport.scrollTop)()).toBe(0));
  await screen.rerender(trace(true, 60));
  expect(viewport.scrollTop).toBe(0);
  await vi.waitFor(() =>
    expect(vertical.getAttribute("aria-valuemax")).toBe(
      String(viewport.scrollHeight - viewport.clientHeight),
    ),
  );
  await act(() => vertical.focus());
  await userEvent.keyboard("{End}");
  await vi.waitFor(() =>
    expect(
      (() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)(),
    ).toBeLessThanOrEqual(1),
  );
  await screen.rerender(trace(true, 70));
  await vi.waitFor(() =>
    expect(
      (() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)(),
    ).toBeLessThanOrEqual(1),
  );
});

it("keeps the newest streamed text in view", async () => {
  await using screen = await render(trace(true, 50));
  const viewport = screen.container.querySelector("pre")!.parentElement!;
  await screen.rerender(trace(true, 60));
  await screen.rerender(trace(true, 70));
  await vi.waitFor(() =>
    expect(
      (() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)(),
    ).toBeLessThanOrEqual(1),
  );
});

it("stops following while reading and resumes after returning to the end", async () => {
  await using screen = await render(trace(true, 50));
  const viewport = screen.container.querySelector("pre")!.parentElement!;
  await act(() => {
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(trace(true, 60));
  expect(viewport.scrollTop).toBe(100);
  await act(() => {
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(trace(true, 70));
  await vi.waitFor(() =>
    expect(
      (() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)(),
    ).toBeLessThanOrEqual(1),
  );
});

it("keeps a settled trace at the reader's position", async () => {
  await using screen = await render(trace(false, 50));
  const viewport = screen.container.querySelector("pre")!.parentElement!;
  await screen.rerender(trace(false, 60));
  expect(viewport.scrollTop).toBe(0);
});
