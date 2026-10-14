// The workspace control for the new-session start page: a PILL that names the folder the session
// will run in, and the picker behind it.
//
// The operator's rule (2026-10-14): 「工作空间确定呢，你也搞一个按钮…不要一开始就把所有目录东西选出来，
// 搞一个按钮，然后弹一个框去选择」. The picker is a STEP, not a page section — so the start page can be
// what he asked for instead: a reduced copy of the chat page. AionUi does the same thing
// (`pages/guid/components/GuidWorkspaceFootnote.tsx`: a folder pill whose menu offers the recent
// workspaces and 「选择其他文件夹」); the difference here is that the browsers's own directory listing is
// one level at a time, which is the flavour `WorkspacePicker` already implements.
import { useState } from "react";
import { IconChevronDown, IconFolder } from "./Icons";
import { WorkspacePicker } from "./WorkspacePicker";

/** The last path segment — what a pill has room to show. */
function tail(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function WorkspaceButton({
  value,
  onChange,
  locked = false,
  testId = "ws-pill",
}: {
  value: string;
  onChange: (path: string) => void;
  /** The directory came from the rail's 「+」: it is already decided, so this is a label, not a control. */
  locked?: boolean;
  testId?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // The dialog edits a DRAFT: closing it without 「用这个目录」 must leave the session's directory alone,
  // which is the whole reason browsing is not live against `value`.
  const [draft, setDraft] = useState(value);

  return (
    <>
      <button
        type="button"
        className={`ws-pill ${value ? "" : "empty"} ${locked ? "locked" : ""}`}
        data-testid={testId}
        aria-label="工作空间"
        title={value || "选择这个会话在哪个目录里跑"}
        disabled={locked}
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        <IconFolder size={14} />
        <span className="ws-pill-name">{value ? tail(value) : "选择工作空间"}</span>
        {locked ? null : <IconChevronDown size={11} />}
      </button>
      {open ? (
        <div className="modal-bg ws-modal-bg" onClick={() => setOpen(false)}>
          <div className="modal ws-modal" onClick={(e) => e.stopPropagation()}>
            <h3>工作空间</h3>
            {/* The picker OWNS "chosen": picking a row, a recent chip or 「选中」 all report through
                `onChange`, so the dialog closes on the pick rather than asking the operator to confirm
                the same fact twice. */}
            <WorkspacePicker
              value={draft}
              onChange={(path) => { onChange(path); setOpen(false); }}
            />
            <div className="row">
              <button className="cancel" onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
