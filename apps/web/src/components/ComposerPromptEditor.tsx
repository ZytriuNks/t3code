import { ComposerPromptEditorTiptap } from "./ComposerPromptEditorTiptap";
import type { ComposerPromptEditorProps } from "./ComposerPromptEditorTiptap";

export type {
  ComposerAccessibleCopy,
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

export function ComposerPromptEditor(props: ComposerPromptEditorProps) {
  return <ComposerPromptEditorTiptap {...props} />;
}
