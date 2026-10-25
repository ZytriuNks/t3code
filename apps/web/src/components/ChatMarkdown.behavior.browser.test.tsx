import { EnvironmentId, ThreadId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

import { MarkdownFindContext } from "./chat/markdownFindContext";
import type { ReactNode } from "react";
import { act, fakeTimers, render, stubGlobal, type Screen } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const diagramRender = vi.hoisted(() => ({ pending: null as Promise<void> | null }));
vi.mock("./chat/MermaidDiagram", async () => {
  const { use } = await import("react");
  return {
    // 固定图表完成时机，验证源码与图表切换时的可见内容。
    MermaidDiagram: () => {
      if (diagramRender.pending) use(diagramRender.pending);
      return <svg aria-label="Diagram" />;
    },
  };
});

vi.mock("../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/session")>();
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const grantedScopes = new Set<AuthEnvironmentScope>(AuthStandardClientScopes);
  const hasScope = (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null && grantedScopes.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});

import ChatMarkdown from "./ChatMarkdown";
import { useRightPanelStore } from "../rightPanelStore";

function setup() {
  const stack = new AsyncDisposableStack();
  diagramRender.pending = null;
  // 此套件检查本地增量高亮，worker 交接由 worker-selection 套件覆盖。
  stack.use(stubGlobal("Worker", undefined));
  const mount = async (ui: ReactNode, options?: Parameters<typeof render>[1]) =>
    stack.use(await render(ui, options));
  return {
    mount,
    markup: async (ui: ReactNode) => (await mount(ui)).container.innerHTML,
    use: <T extends Disposable>(resource: T) => stack.use(resource),
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

function codeButton(screen: Screen, label: string) {
  const button = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="' + label + '"]',
  );
  if (!button) throw Error("Missing code button: " + label);
  return button;
}

describe("ChatMarkdown bare anchor placeholders", () => {
  it.each(["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"])(
    "preserves unmatched %s without linking later blocks",
    async (token) => {
      await using fixture = setup();
      const { markup } = fixture;
      const text = `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`;
      const document = new DOMParser().parseFromString(
        await markup(<ChatMarkdown cwd="/tmp/project" text={text} />),
        "text/html",
      );

      expect(document.querySelector("strong")?.textContent).toBe(`"From ${token}"`);
      expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
        "the link",
      ]);
      expect(document.querySelectorAll("li")).toHaveLength(2);
      expect(
        [...document.querySelectorAll("p")].map((paragraph) => paragraph.textContent),
      ).toContain("The deferred move continues on B.");
    },
  );

  it.each(["</a>  ", "<div>more</div>\n</a>"])(
    "preserves a paired anchor closing in the raw block %s",
    async (closing) => {
      await using fixture = setup();
      const { markup } = fixture;
      const document = new DOMParser().parseFromString(
        await markup(
          <ChatMarkdown cwd="/tmp/project" text={`See <a>label\n\n${closing}\n\nfinish`} />,
        ),
        "text/html",
      );
      expect(document.querySelector("p")?.textContent).toBe("See label");
    },
  );

  it("preserves a paired anchor after comment-looking raw text", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const document = new DOMParser().parseFromString(
      await markup(
        <ChatMarkdown cwd="/tmp/project" text="See <a>label<script><!-- </script> --></a>" />,
      ),
      "text/html",
    );
    expect(document.querySelector("p")?.textContent).toBe("See label -->");
  });

  it.each(["<!-- </a> -->", '<div title="</a>">more</div>', '<script>"</a>"</script>'])(
    "ignores apparent closing anchors inside %s",
    async (html) => {
      await using fixture = setup();
      const { markup } = fixture;
      const document = new DOMParser().parseFromString(
        await markup(<ChatMarkdown cwd="/tmp/project" text={`Before <A>.\n\n${html}\n\nAfter.`} />),
        "text/html",
      );
      expect(document.querySelector("p")?.textContent).toBe("Before <A>.");
      expect(document.querySelectorAll("a")).toHaveLength(0);
    },
  );

  it("preserves paired HTML anchors, details, markdown links, and inline code", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const text =
      'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>';
    const document = new DOMParser().parseFromString(
      await markup(<ChatMarkdown cwd="/tmp/project" text={text} />),
      "text/html",
    );

    expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "label",
      "",
      "docs",
    ]);
    expect(document.querySelector("code")?.textContent).toBe("<A>");
    expect(document.querySelector("[data-markdown-details]")?.textContent).toContain("More");
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip renderer, with readable fallback", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    let renderer: Screen | undefined;
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    try {
      await act(async () => {
        renderer = await mount(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            renderContextReference={({ kind, label }) => (
              <button>
                {kind}: {label}
              </button>
            )}
          />,
        );
      });
      expect(
        Array.from(renderer!.container.querySelectorAll<HTMLElement>("button")).map(
          (button) => button.textContent,
        ),
      ).toEqual(["terminal: Terminal output", "image: Error image"]);
      expect(Array.from(renderer!.container.querySelectorAll<HTMLElement>("img"))).toHaveLength(0);
      expect(Array.from(renderer!.container.querySelectorAll<HTMLElement>("a"))).toHaveLength(0);
      await act(async () => {
        await renderer!.rerender(<ChatMarkdown cwd={undefined} text={text} />);
      });
      expect(
        Array.from(renderer!.container.querySelectorAll<HTMLElement>("span")).map(
          (span) => span.textContent,
        ),
      ).toEqual(["Terminal output", "Error image"]);
      expect(Array.from(renderer!.container.querySelectorAll<HTMLElement>("img"))).toHaveLength(0);
    } finally {
      await act(async () => {
        await renderer?.unmount();
      });
    }
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    let renderer: Screen | undefined;
    const seen: Array<string> = [];
    try {
      await act(async () => {
        renderer = await mount(
          <ChatMarkdown
            cwd={undefined}
            text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
            renderContextReference={({ kind, label }) => {
              seen.push(`${kind}: ${label}`);
              return <button>{label}</button>;
            }}
          />,
        );
      });
      expect(seen).toEqual(["terminal: Bold code"]);
    } finally {
      await act(async () => {
        await renderer?.unmount();
      });
    }
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    let renderer: Screen | undefined;
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    try {
      await act(async () => {
        renderer = await mount(markdown("https://example.com"));
      });
      expect(
        Array.from(renderer!.container.querySelectorAll<HTMLElement>("img")).map((image) =>
          image.getAttribute("src"),
        ),
      ).toEqual(["https://www.google.com/s2/favicons?domain=example.com&sz=32"]);
      for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
        await act(async () => {
          await renderer!.rerender(markdown(url));
        });
        expect(Array.from(renderer!.container.querySelectorAll<HTMLElement>("img"))).toHaveLength(
          0,
        );
      }
      await act(async () => {
        await renderer!.rerender(markdown("https://example.com"));
      });
      expect(Array.from(renderer!.container.querySelectorAll<HTMLElement>("img"))).toHaveLength(1);
      // GitHub links draw the brand mark in currentColor instead of fetching a favicon.
      await act(async () => {
        await renderer!.rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
      });
      expect(Array.from(renderer!.container.querySelectorAll<HTMLElement>("img"))).toHaveLength(0);
      expect(renderer!.container.querySelectorAll("a svg")).toHaveLength(1);
    } finally {
      await act(async () => {
        await renderer?.unmount();
      });
    }
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    const onRunShellCommand = vi.fn();
    let renderer: Screen | undefined;
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    try {
      await act(async () => {
        renderer = await mount(message("```bash\necho hello\n```", true));
      });
      const mounted = renderer!;
      expect(!!mounted.container.querySelector('button[aria-label="Run in terminal"]')).toBe(false);

      await act(async () => {
        mounted.rerender(message("```bash\necho hello\n```"));
      });
      await act(async () => {
        codeButton(mounted, "Run in terminal").click();
      });
      expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

      for (const text of [
        "~~~bash\necho tilde\n~~~",
        "> ```bash\n> echo quote\n> ```",
        "````bash\necho four\n````",
      ]) {
        await act(async () => {
          mounted.rerender(message(text));
        });
        expect(codeButton(mounted, "Run in terminal")).toBeDefined();
      }

      for (const text of [
        "```bash\necho one\necho two\n```",
        "```typescript\necho hello\n```",
        "```bash\n\n```",
        "```bash\necho hello\n\n```",
        "```bash\necho hello\\\n```",
        "```bash\necho safe \u202e#\n```",
        "```bash\necho incomplete",
        "~~~bash\necho incomplete",
        "````bash\necho incomplete\n```",
        '<pre><code class="language-bash">echo html</code></pre>',
      ]) {
        await act(async () => {
          mounted.rerender(message(text));
        });
        expect(!!mounted.container.querySelector('button[aria-label="Run in terminal"]')).toBe(
          false,
        );
      }
    } finally {
      await act(async () => renderer?.unmount());
    }
  });

  it("does not retokenize completed lines when streaming finishes", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    let renderer: Screen | undefined;
    const text = "```typescript\nconst completed = 1;\nconst current = 2;";
    try {
      await act(async () => {
        renderer = await mount(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
      });
      expect(highlight).toHaveBeenCalled();
      highlight.mockClear();
      await act(async () => {
        await renderer!.rerender(<ChatMarkdown cwd="/tmp/project" text={text + "\n```"} />);
      });
      expect(highlight.mock.calls.every(([code]) => !code.includes("const completed"))).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
      vi.restoreAllMocks();
    }
  });

  it("recovers highlighting after a failed fence changes without resetting its controls", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    const highlighter = await getSyntaxHighlighterPromise("text");
    const codeToHast = highlighter.codeToHast.bind(highlighter);
    let fail = true;
    vi.spyOn(highlighter, "codeToHast").mockImplementation((...args) => {
      if (fail) throw new Error("Temporary highlighter failure");
      return codeToHast(...args);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let renderer: Screen | undefined;

    try {
      await act(async () => {
        renderer = await mount(
          <ChatMarkdown cwd="/tmp/project" text={"```text\ninitial\n```"} isStreaming />,
        );
      });
      const mounted = renderer!;
      const codeBlock = mounted.container.querySelector<HTMLElement>('[data-language="text"]')!;
      const initialWrap = codeBlock.dataset.wrap === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      await act(async () => {
        wrap.click();
      });
      expect(mounted.container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(0);

      fail = false;
      await act(async () => {
        mounted.rerender(
          <ChatMarkdown cwd="/tmp/project" text={"```text\nrecovered\n```"} isStreaming />,
        );
      });
      expect(mounted.container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(1);
      expect(mounted.container.querySelector<HTMLElement>('[data-language="text"]')!).toBe(
        codeBlock,
      );
      expect(codeBlock.dataset.wrap).toBe(String(!initialWrap));
    } finally {
      await act(async () => renderer?.unmount());
      vi.restoreAllMocks();
    }
  });

  it("preserves code controls and details without highlighting an unchanged fence again", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    const highlighter = await getSyntaxHighlighterPromise("text");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    const writeText = vi.fn(async (_text: string) => {});
    fixture.use(
      stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText } } })),
    );
    using _timers = fakeTimers();
    let renderer: Screen | undefined;
    const text = [
      "```text",
      "First code block",
      "```",
      "",
      "<details><summary>More</summary>",
      "",
      "Details content",
      "",
      "</details>",
      "",
      "Streaming reply",
    ].join("\n");

    try {
      await act(async () => {
        renderer = await mount(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
      });
      const mounted = renderer!;
      const codeBlock = mounted.container.querySelector<HTMLElement>('[data-language="text"]')!;
      const initialWrap = codeBlock.dataset.wrap === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      const copy = codeButton(mounted, "Copy code");
      await act(async () => {
        wrap.click();
        copy.click();
      });

      const detailsButton = mounted.container.querySelector<HTMLButtonElement>(
        "button[data-markdown-details-summary]",
      )!;
      await act(() => detailsButton.click());
      const details = mounted.container.querySelector<HTMLElement>("[data-markdown-details]")!;
      expect(details.dataset.markdownDetailsOpen).toBe("true");
      expect(writeText).toHaveBeenCalledWith("First code block\n");
      expect(highlight).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 10; index += 1) {
        await act(async () => {
          mounted.rerender(
            <ChatMarkdown cwd="/tmp/project" text={`${text} ${index}`} isStreaming />,
          );
        });
      }

      expect(highlight).toHaveBeenCalledTimes(1);
      expect(mounted.container.querySelector<HTMLElement>('[data-language="text"]')!).toBe(
        codeBlock,
      );
      expect(codeBlock.dataset.wrap).toBe(String(!initialWrap));
      expect(mounted.container.querySelector<HTMLElement>("[data-markdown-details]")!).toBe(
        details,
      );
      expect(details.dataset.markdownDetailsOpen).toBe("true");
      await act(async () => {
        mounted.rerender(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text.replace("First code block", "Updated code block")}
            isStreaming
          />,
        );
      });
      const copyUpdated = codeButton(mounted, "Copied");
      await act(async () => {
        copyUpdated.click();
      });
      expect(writeText).toHaveBeenLastCalledWith("Updated code block\n");
      expect(highlight).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => renderer?.unmount());
      vi.restoreAllMocks();
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    let renderer: Screen | undefined;
    let editedText: string | undefined;
    const message = (text: string) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void renderer!.rerender(message(editedText));
        }}
      />
    );

    try {
      await act(async () => {
        renderer = await mount(message("- [ ] First\n- [ ] Second"));
      });
      const mounted = renderer!;
      const originalInput = Array.from(
        mounted.container.querySelectorAll<HTMLInputElement>("input"),
      )[1]!;
      await act(async () => {
        mounted.rerender(message("- [ ] A longer first task\n- [ ] Second"));
      });

      const input = Array.from(mounted.container.querySelectorAll<HTMLInputElement>("input"))[1]!;
      await act(() => input.click());

      expect(input).toBe(originalInput);
      expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
      expect(
        Array.from(mounted.container.querySelectorAll<HTMLInputElement>("input"))[1]!.checked,
      ).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});

describe("ChatMarkdown skill chips", () => {
  it("updates digit-leading skill labels when discovered skills change", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    let renderer: Screen | undefined;
    const text = "Use $2spec with a $20k budget.";
    try {
      await act(async () => {
        renderer = await mount(<ChatMarkdown cwd="/tmp/project" text={text} />);
      });
      const mounted = renderer!;
      const labels = (label: string) =>
        Array.from(mounted.container.querySelectorAll<HTMLElement>("span")).filter((node) =>
          [...node.childNodes].some(
            (child) => child.nodeType === Node.TEXT_NODE && child.textContent === label,
          ),
        );
      expect(labels("2Spec")).toHaveLength(0);

      await act(async () => {
        mounted.rerender(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text}
            skills={[
              { name: "2spec", displayName: "2Spec" },
              { name: "20k", displayName: "MoneySkill" },
            ]}
          />,
        );
      });
      expect(labels("2Spec")).toHaveLength(1);
      expect(labels("MoneySkill")).toHaveLength(0);

      await act(async () => {
        mounted.rerender(<ChatMarkdown cwd="/tmp/project" text={text} skills={[]} />);
      });
      expect(labels("2Spec")).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});

describe("ChatMarkdown file option chips", () => {
  it("keeps the fallback button text selectable", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown cwd="/tmp/project" text="[Source](/tmp/project/src/main.ts)" />,
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("select-text");
  });

  it.each([true, false])(
    "renders Codex file citations as file chips with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using fixture = setup();
      const { markup } = fixture;
      const html = await markup(
        <ChatMarkdown
          cwd="/tmp/project"
          text={
            'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.'
          }
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).not.toContain("codex-file-citation");
      expect(html).toContain("chat-markdown-file-link");
      expect(html).toContain(
        'data-markdown-copy="[report.xlsx](/tmp/project/outputs/report.xlsx)"',
      );
      expect(html).toContain("report.xlsx");
    },
  );

  it("leaves an unfinished streaming citation visible until it is complete", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"'}
        isStreaming
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("leaves malformed and similarly named file directives literal", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    for (const text of [
      ':codex-file-citation{purpose="output"}',
      ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}',
    ]) {
      const html = await markup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(new DOMParser().parseFromString(html, "text/html").body.textContent).toContain(text);
      expect(html).not.toContain("chat-markdown-file-link");
    }
  });

  it("preserves Codex file citation examples inside code", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`Example: \`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``}
      />,
    );

    expect(html.match(/:codex-file-citation/g)).toHaveLength(2);
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("preserves escaped Codex file citations as literal text", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Example: \\:codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("does not create a nested link for citations inside link text", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = await markup(
      <ChatMarkdown cwd="/tmp/project" text={`[See ${directive}](https://example.com)`} />,
    );
    const renderedText = html.replace(/<[^>]+>/g, "");

    expect(renderedText).toContain("codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("renders file citations created by over-indented list recovery", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'-       Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).not.toContain("<pre>");
    expect(html).toContain("Created ");
    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain("report.xlsx");
  });

  it("disambiguates Codex citations with the same basename", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.'
        }
      />,
    );

    expect(html).toContain("index.ts · project/src");
    expect(html).toContain("index.ts · project/test");
  });

  it("preserves rejected citations created by over-indented list recovery", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const malformedHtml = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Leading text before list.\n\n-       Bad :codex-file-citation{purpose="output"}'}
      />,
    );
    const nestedLinkHtml = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Leading text before list.\n\n-       [Bad :codex-file-citation{path="/tmp/project/report.xlsx"}](https://example.com)'
        }
      />,
    );
    const nestedLinkText = new DOMParser().parseFromString(nestedLinkHtml, "text/html").body
      .textContent;

    expect(
      new DOMParser().parseFromString(malformedHtml, "text/html").querySelector("li")?.textContent,
    ).toBe('Bad :codex-file-citation{purpose="output"}');
    expect(nestedLinkText).toContain('Bad :codex-file-citation{path="/tmp/project/report.xlsx"}');
  });
});

describe("ChatMarkdown Codex follow-up suggestions", () => {
  it.each([true, false])("renders the label with parseRawHtml=%s", async (parseRawHtml) => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Done.\n\n- :codex-followup[Prepare print version]{prompt="Prepare the document for printing."}'
        }
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain("Prepare print version");
    expect(html).not.toContain("codex-followup");
    expect(html).not.toContain("Prepare the document for printing.");
  });

  it("keeps the label of a malformed follow-up created by over-indented list recovery", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text="-       Next :codex-followup[Prepare print version]"
      />,
    );

    expect(html).toContain("<li>Next :codex-followup[Prepare print version]</li>");
  });
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown artifact-template cards", () => {
  it.each([true, false])(
    "renders the Codex result card with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using fixture = setup();
      const { markup } = fixture;
      const html = await markup(
        <ChatMarkdown
          cwd="/tmp/project"
          text={ARTIFACT_TEMPLATE_DIRECTIVE}
          parseRawHtml={parseRawHtml}
          onUseArtifactTemplate={() => undefined}
        />,
      );

      expect(html).not.toContain("::artifact-template");
      expect(html).toContain("data-chat-markdown-artifact-template");
      expect(html).toContain('data-artifact-kind="document"');
      expect(html).toContain('data-markdown-copy="Hello World (Document template)\n\n"');
      expect(html).toContain('data-skill-name="artifact-template-hello-world"');
      expect(html).toContain("Hello World");
      expect(html).toContain("Document template");
      expect(html).toContain("Use template");
      expect(html).not.toContain("<p><div");
    },
  );

  it("renders a passive card outside a composer-backed timeline", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown cwd="/tmp/project" text={ARTIFACT_TEMPLATE_DIRECTIVE} />,
    );

    expect(html).toContain("data-chat-markdown-artifact-template");
    expect(html).not.toContain("Use template");
  });

  it("leaves malformed and unfinished artifact-template directives literal", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const malformed =
      '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';
    const unfinished = ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1);

    for (const text of [malformed, unfinished]) {
      const html = await markup(<ChatMarkdown cwd="/tmp/project" text={text} />);
      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("data-chat-markdown-artifact-template");
    }
  });

  it("leaves escaped and similarly named artifact-template directives literal", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    for (const text of [
      `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
      ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
    ]) {
      const html = await markup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("data-chat-markdown-artifact-template");
    }
  });

  it("preserves artifact-template examples inside code", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`\`${ARTIFACT_TEMPLATE_DIRECTIVE}\`\n\n\`\`\`text\n${ARTIFACT_TEMPLATE_DIRECTIVE}\n\`\`\``}
      />,
    );

    expect(html.match(/::artifact-template/g)).toHaveLength(2);
    expect(html).not.toContain("data-chat-markdown-artifact-template");
  });
});

describe("ChatMarkdown heading levels", () => {
  it("exposes headings below the host heading without changing their tags", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    const screen = await mount(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"# Top\n\n## Section\n\n###### Fine print"}
        headingLevelOffset={3}
      />,
    );

    expect(
      [...screen.container.querySelectorAll("h1,h2,h6")].map((node) => [
        node.tagName,
        node.getAttribute("aria-level"),
        node.textContent,
      ]),
    ).toEqual([
      ["H1", "4", "Top"],
      ["H2", "5", "Section"],
      ["H6", "6", "Fine print"],
    ]);
  });

  it("leaves heading levels alone when the markdown is not nested", async () => {
    await using fixture = setup();
    const { mount } = fixture;
    const screen = await mount(<ChatMarkdown cwd="/tmp/project" text="# Top" />);

    expect(screen.container.querySelector("h1")?.textContent).toBe("Top");
    expect(screen.container.querySelector("h1")?.hasAttribute("aria-level")).toBe(false);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const threadRef = { environmentId, threadId: ThreadId.make("windows-thread") };

  it.each([true, false])("preserves drive paths with parseRawHtml=%s", async (parseRawHtml) => {
    await using fixture = setup();
    const { mount } = fixture;
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    const screen = await mount(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        threadRef={threadRef}
        text="[Open](C:/Users/shawn/project/src/main.ts)"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    const link = screen.container.querySelector<HTMLAnchorElement>("a.chat-markdown-file-link")!;
    expect(link).not.toBeNull();
    await act(() => link.click());
    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "src/main.ts", undefined);
  });

  it.each([true, false])("normalizes backslashes with parseRawHtml=%s", async (parseRawHtml) => {
    await using fixture = setup();
    const { mount } = fixture;
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    const screen = await mount(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        threadRef={threadRef}
        text={String.raw`[Open](C:\Users\shawn\project\src\main.ts)`}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    const link = screen.container.querySelector<HTMLAnchorElement>("a.chat-markdown-file-link")!;
    expect(link).not.toBeNull();
    await act(() => link.click());
    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "src/main.ts", undefined);
  });

  it.each([true, false])(
    "keeps backslashes CommonMark would read as escapes with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using fixture = setup();
      const { mount } = fixture;
      using openFile = vi
        .spyOn(useRightPanelStore.getState(), "openFile")
        .mockImplementation(() => {});
      const screen = await mount(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          threadRef={threadRef}
          text={String.raw`[settings](C:\Users\shawn\.claude\settings.json)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      const link = screen.container.querySelector<HTMLAnchorElement>("a.chat-markdown-file-link")!;
      expect(link).not.toBeNull();
      await act(() => link.click());
      expect(openFile).toHaveBeenCalledExactlyOnceWith(
        threadRef,
        "C:/Users/shawn/.claude/settings.json",
        undefined,
      );
    },
  );

  it.each([true, false])(
    "distinguishes same-named backslash paths with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using fixture = setup();
      const { markup } = fixture;
      const html = await markup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).toContain("index.ts · project/src");
      expect(html).toContain("index.ts · project/test");
    },
  );

  it.each([true, false])(
    "does not disambiguate the same file in links and inline code with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using fixture = setup();
      const { markup } = fixture;
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      const html = await markup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={`[Source](${path}) and \`${path}\``}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html.match(/chat-markdown-file-link/g)).toHaveLength(2);
      expect(html).not.toContain("main.ts ·");
    },
  );

  it.each([true, false])("preserves reference links with parseRawHtml=%s", async (parseRawHtml) => {
    await using fixture = setup();
    const { mount } = fixture;
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    const screen = await mount(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        threadRef={threadRef}
        text={"[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    const link = screen.container.querySelector<HTMLAnchorElement>("a.chat-markdown-file-link")!;
    expect(link).not.toBeNull();
    await act(() => link.click());
    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "src/main.ts", undefined);
  });

  it.each([true, false])(
    "still rejects unsafe schemes with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using fixture = setup();
      const { markup } = fixture;
      const html = await markup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text="[unsafe](javascript:alert(1)) and [unknown](d:alert(1))"
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("d:alert");
      expect(html).not.toContain("chat-markdown-file-link");
    },
  );
});

it("opens a disclosure only when find selects a match inside it", async () => {
  await using fixture = setup();
  const { mount } = fixture;
  fixture.use(
    stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      },
    ),
  );
  const highlights = new Map<string, Set<Range>>();
  fixture.use(stubGlobal("CSS", Object.create(CSS, { highlights: { value: highlights } })));
  const container = document.createElement("div");
  document.body.append(container);
  const root = await mount(null, { container });
  const openStates = () =>
    [...container.querySelectorAll("[data-markdown-details-open]")].map((node) =>
      node.getAttribute("data-markdown-details-open"),
    );
  function Probe({
    activeOccurrence,
    searching = true,
  }: {
    activeOccurrence: number;
    searching?: boolean;
  }) {
    useThreadFindHighlights({
      container,
      query: searching ? "needle" : "",
      activeRowId: "row",
      activeOccurrence,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={searching}>
            <ChatMarkdown
              cwd={undefined}
              text={[
                "Visible needle.",
                "<details><summary>Unrelated</summary><p>nothing here</p></details>",
                "<details><summary>Outer</summary><details><summary>Inner</summary><p>needle</p></details></details>",
              ].join("\n\n")}
            />
          </MarkdownFindContext>
        </div>
      </div>
    );
  }
  try {
    // Closed panels are unmounted until find starts, as in the app.
    await act(() => root.rerender(<Probe activeOccurrence={0} searching={false} />));
    expect(container.textContent).not.toContain("nothing here");
    await act(() => root.rerender(<Probe activeOccurrence={0} />));
    // Selecting the visible match opens nothing; the folded one is counted but not painted.
    await vi.waitFor(() => {
      expect(openStates()).toEqual(["false", "false", "false"]);
      expect(container.textContent).toContain("nothing here");
      expect(
        [...(highlights.get("t3-thread-find-active") ?? [])].map((range) => range.toString()),
      ).toEqual(["needle"]);
      expect(highlights.get("t3-thread-find")?.size).toBe(0);
    });

    await act(() => root.rerender(<Probe activeOccurrence={1} />));
    // Stepping to the folded match opens its two ancestors, not the unrelated one.
    await vi.waitFor(() => {
      expect(openStates()).toEqual(["false", "true", "true"]);
      expect(highlights.get("t3-thread-find-active")?.size).toBe(1);
    });
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it.each([false, true])(
  "keeps painted Mermaid source while its EOF diagram is pending (smooth=%s)",
  async (smoothStreaming) => {
    await using fixture = setup();
    const { mount } = fixture;
    let finishDiagram!: () => void;
    diagramRender.pending = new Promise<void>((resolve) => {
      finishDiagram = resolve;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = await mount(null, { container });
    const text =
      "```mermaid\ngraph TD\n  ALREADY_PAINTED_NODE --> LastNode\n```\n\n" +
      "## References\n\nThe final visible paragraph must stay below the code.";
    const render = (isStreaming: boolean) =>
      act(() =>
        root.rerender(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            isStreaming={isStreaming}
            smoothStreaming={smoothStreaming}
          />,
        ),
      );
    try {
      await render(true);
      expect(container.querySelector("pre")?.textContent ?? "").toContain("ALREADY_PAINTED_NODE");
      await render(false);
      // EOF不能先拿掉已绘制的代码，再用较矮占位符挤动后续正文。
      expect(container.querySelector("pre")?.textContent ?? "").toContain("ALREADY_PAINTED_NODE");
      expect(container.textContent).toContain("The final visible paragraph");
      await act(async () => finishDiagram());
      expect(container.querySelector('svg[aria-label="Diagram"]')).not.toBeNull();
      expect(container.querySelector("pre")).toBeNull();
    } finally {
      await act(async () => {
        finishDiagram();
        await root.unmount();
      });
      diagramRender.pending = null;
      container.remove();
    }
  },
);

it.each([false, true])(
  "renders a closed Mermaid fence before EOF and preserves its diagram at EOF (smooth=%s)",
  async (smoothStreaming) => {
    await using fixture = setup();
    const { mount } = fixture;
    using _timers = fakeTimers();
    const container = document.createElement("div");
    document.body.append(container);
    const root = await mount(null, { container });
    const open = "```mermaid\ngraph TD\n  StableNode --> LastNode\n";
    const closed = `${open}\`\`\`\n\nThe response is still streaming.`;
    const render = (text: string, isStreaming: boolean) =>
      act(() =>
        root.rerender(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            isStreaming={isStreaming}
            smoothStreaming={smoothStreaming}
          />,
        ),
      );
    try {
      await render(open, true);
      expect(container.querySelector('svg[aria-label="Diagram"]')).toBeNull();
      expect(container.querySelector("pre")?.textContent ?? "").toContain("StableNode");
      await render(closed, true);
      // 平滑模式会合并源码提交，先交付该批次，再检查图表是否仍错误地等待 EOF。
      await act(async () => vi.advanceTimersByTime(96));
      const diagram = container.querySelector('svg[aria-label="Diagram"]');
      expect(diagram).not.toBeNull();
      await render(closed, false);
      expect(container.querySelector('svg[aria-label="Diagram"]')).toBe(diagram);
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  },
);

it("keeps Mermaid diagrams rendered until find selects a match in their source", async () => {
  await using fixture = setup();
  const { mount } = fixture;
  fixture.use(
    stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      },
    ),
  );
  const highlights = new Map<string, Set<Range>>();
  fixture.use(stubGlobal("CSS", Object.create(CSS, { highlights: { value: highlights } })));
  const container = document.createElement("div");
  document.body.append(container);
  const root = await mount(null, { container });
  const diagram = "```mermaid\ngraph TD; Alpha-->Beta\n```";
  function Probe({ query }: { query: string }) {
    useThreadFindHighlights({
      container,
      query,
      activeRowId: "row",
      activeOccurrence: 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={true}>
            <ChatMarkdown cwd={undefined} text={`Needle first.\n\n${diagram}\n\n${diagram}`} />
          </MarkdownFindContext>
        </div>
      </div>
    );
  }
  const diagrams = () => container.querySelectorAll('svg[aria-label="Diagram"]').length;
  try {
    await act(() => root.rerender(<Probe query="Needle" />));
    await vi.waitFor(() => {
      expect(diagrams()).toBe(2);
      expect(
        [...(highlights.get("t3-thread-find-active") ?? [])].map((range) => range.toString()),
      ).toEqual(["Needle"]);
    });
    await act(() => root.rerender(<Probe query="Alpha" />));
    // Only the diagram holding the selected match switches to source.
    await vi.waitFor(() => {
      expect(diagrams()).toBe(1);
      expect(
        [...(highlights.get("t3-thread-find-active") ?? [])].map((range) => range.toString()),
      ).toEqual(["Alpha"]);
    });
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it.each([
  {
    text: "```mermaid\ngraph TD; SearchSourceAlpha-->B\n```",
    query: "SearchSourceAlpha",
    count: 1,
  },
  {
    text: "★ Insight ─────\nfirst line\nsecond line",
    query: "first line second",
    count: 0,
    lineBreaks: true,
  },
  { text: '```ts title="src/needle.ts"\nconst a = 1;\n```', query: "needle", count: 0 },
  { text: "```weirdlang\nconst a = 1;\n```", query: "weirdlang", count: 0 },
  { text: "Use $test-t3-app now", query: "T3 App Testing", count: 1 },
  { text: "`/tmp/file.ts:42`", query: "file.ts · L42", count: 1, user: true, lineBreaks: true },
  { text: "> [!NOTE]\n> Searchable alert", query: "Searchable alert", count: 1 },
  {
    text: "<details><summary>Folded</summary><p>Hidden needle</p></details>",
    query: "Hidden needle",
    count: 1,
  },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, withTemplateAction: true },
  {
    text: ARTIFACT_TEMPLATE_DIRECTIVE,
    query: "Document template",
    count: 1,
    withTemplateAction: true,
  },
  {
    text: ARTIFACT_TEMPLATE_DIRECTIVE,
    query: "World Document",
    count: 0,
    withTemplateAction: true,
  },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, withTemplateAction: true },
])(
  "highlights the indexed occurrences of $query in $text",
  async ({ text, query, count, lineBreaks, user, withTemplateAction }) => {
    await using fixture = setup();
    const { mount } = fixture;
    const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];
    const highlights = new Map<string, Set<Range>>();
    fixture.use(
      stubGlobal(
        "Highlight",
        class extends Set<Range> {
          constructor(...ranges: Range[]) {
            super(ranges);
          }
        },
      ),
    );
    fixture.use(stubGlobal("CSS", Object.create(CSS, { highlights: { value: highlights } })));
    const container = document.createElement("div");
    document.body.append(container);
    const root = await mount(null, { container });
    function Probe() {
      useThreadFindHighlights({
        container,
        query,
        activeRowId: "row",
        activeOccurrence: 0,
        onActiveRange: () => {},
      });
      return (
        <div data-timeline-row-id="row">
          <div data-thread-find-text>
            <MarkdownFindContext value={true}>
              <ChatMarkdown
                text={text}
                cwd={undefined}
                skills={skills}
                lineBreaks={lineBreaks ?? false}
                parseRawHtml={!user}
                onUseArtifactTemplate={withTemplateAction ? () => undefined : undefined}
              />
            </MarkdownFindContext>
          </div>
        </div>
      );
    }
    try {
      await act(() => root.rerender(<Probe />));
      await vi.waitFor(() => {
        expect(highlights.has("t3-thread-find")).toBe(true);
        const ranges = [...highlights.values()].flatMap((value) => [...value]);
        expect(ranges.map((range) => range.toString())).toEqual(
          Array.from({ length: count }, () => query),
        );
      });
      const segments =
        searchableMessageSegments(
          { role: user ? "user" : "assistant", text, streaming: false },
          undefined,
          skills,
        ) ?? [];
      expect(
        segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
      ).toBe(count);
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  },
);

describe("ChatMarkdown heading ids", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    await using fixture = setup();
    const { markup } = fixture;
    const html = await markup(
      <ChatMarkdown
        cwd="/tmp/project"
        parseRawHtml
        text={
          '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install'
        }
      />,
    );
    const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ChatMarkdown in-page links", () => {
  it.each([true, false])(
    "scrolls a table-of-contents link to its heading without touching the URL (parseRawHtml=%s)",
    async (parseRawHtml) => {
      await using fixture = setup();
      const { mount } = fixture;
      const container = document.createElement("div");
      document.body.append(container);
      const root = await mount(null, { container });
      window.history.replaceState(null, "", "/#/env/thread");
      const scrollIntoView = vi.fn();
      using _scroll = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(scrollIntoView);
      try {
        await act(async () => {
          root.rerender(
            <ChatMarkdown
              cwd="/tmp/project"
              parseRawHtml={parseRawHtml}
              text={
                "- [Operating model](#1-operating-model)\n- [Missing](#nowhere)\n\n## 1. Operating model\n\n## 1. Operating model"
              }
            />,
          );
        });
        const headings = [...container.querySelectorAll("h2")];
        expect(headings.map((heading) => heading.id)).toEqual([
          "user-content-1-operating-model",
          "user-content-1-operating-model-1",
        ]);

        const [tocLink, missingLink] = [...container.querySelectorAll("a")];
        const click = () => new MouseEvent("click", { bubbles: true, cancelable: true });
        const tocClick = click();
        tocLink!.dispatchEvent(tocClick);
        expect(tocClick.defaultPrevented).toBe(true);
        expect(scrollIntoView.mock.contexts).toEqual([headings[0]]);

        const missingClick = click();
        missingLink!.dispatchEvent(missingClick);
        expect(missingClick.defaultPrevented).toBe(true);
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(window.location.hash).toBe("#/env/thread");
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    },
  );
});
