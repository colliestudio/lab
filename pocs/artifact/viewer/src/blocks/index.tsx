import type { Block } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { ApiBlock, CalloutBlock, ChecklistBlock, CodeBlock, DataModelBlock, MarkdownBlock, QuestionsBlock, StepsBlock } from "./simple.tsx";
import { FlowBlock } from "./flow.tsx";
import { BeforeAfterBlock } from "./before-after.tsx";
import { DemoBlock } from "./demo.tsx";
import { FilesBlock } from "./files.tsx";
import { DiffBlock } from "./diff.tsx";

export function BlockView({ block }: { block: Block }) {
  const { getFile } = useViewer();
  switch (block.type) {
    case "markdown": return <MarkdownBlock block={block} />;
    case "callout": return <CalloutBlock block={block} />;
    case "flow": return <FlowBlock block={block} />;
    case "demo": return <DemoBlock block={block} getFile={getFile} />;
    case "before-after": return <BeforeAfterBlock block={block} />;
    case "data-model": return <DataModelBlock block={block} />;
    case "api": return <ApiBlock block={block} />;
    case "steps": return <StepsBlock block={block} />;
    case "questions": return <QuestionsBlock block={block} />;
    case "checklist": return <ChecklistBlock block={block} />;
    case "files": return <FilesBlock block={block} />;
    case "diff": return <DiffBlock block={block} />;
    case "code": return <CodeBlock block={block} />;
    default: return <pre className="unknown">{JSON.stringify(block, null, 2)}</pre>;
  }
}

export const BLOCK_LABEL: Partial<Record<Block["type"], string>> = {
  flow: "Flow", demo: "Demo", "before-after": "Before / after", "data-model": "Data model", api: "API",
  steps: "Steps", questions: "Decisions", checklist: "How to verify", files: "Files", diff: "Diff", code: "Code",
};
