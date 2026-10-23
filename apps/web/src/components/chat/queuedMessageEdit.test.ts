import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("retains saved attachments alongside newly uploaded files", async () => {
    const saved = { ...uploadedFile, id: "saved:earlier" };
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [saved],
      images: [],
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "unused",
    });
    expect(attachments).toEqual([saved, uploadedFile]);
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("keeps file-only edits when another client starts the queued run", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    store.addFiles(editTarget, [file]);
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("preserves uploaded file references when a remote queue advance interrupts the edit", () => {
    const store = useComposerDraftStore.getState();
    const uploaded = {
      ...file,
      file: null,
      uploadedAttachmentId: uploadedFile.id,
      uploadEnvironmentId: environmentId,
    };
    store.addFiles(editTarget, [uploaded]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([uploaded]);
  });

  it.each([false, true])(
    "keeps thread references and clears the edit source (context-only: %s)",
    (contextOnly) => {
      const store = useComposerDraftStore.getState();
      const reference = threadContextRecord(
        scopeThreadRef(environmentId, ThreadId.make("thread:reference")),
        "Earlier thread",
      );
      if (!contextOnly) store.setPrompt(editTarget, "Original message");
      store.setThreadContexts(editTarget, [reference]);
      const originalText = store.getComposerDraft(editTarget)?.prompt ?? "";

      expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText })).toBe("kept");
      expect(store.getComposerDraft(threadTarget)?.threadContexts).toEqual([reference]);
      expect(store.getComposerDraft(threadTarget)?.prompt).toContain(reference.contextId);
      expect(store.getComposerDraft(editTarget)).toBeNull();
    },
  );

  it("does not overwrite a separate thread reference draft when recovering an edit", () => {
    const store = useComposerDraftStore.getState();
    const existing = threadContextRecord(
      scopeThreadRef(environmentId, ThreadId.make("thread:existing")),
      "Existing reference",
    );
    const edited = threadContextRecord(
      scopeThreadRef(environmentId, ThreadId.make("thread:edited")),
      "Edited reference",
    );
    store.setThreadContexts(threadTarget, [existing]);
    store.setThreadContexts(editTarget, [edited]);

    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe(
      "discarded",
    );
    expect(store.getComposerDraft(threadTarget)?.threadContexts).toEqual([existing]);
    expect(store.getComposerDraft(threadTarget)?.prompt).not.toContain(edited.contextId);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("does not overwrite a separate draft when the queued run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe(
      "discarded",
    );
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });
});
