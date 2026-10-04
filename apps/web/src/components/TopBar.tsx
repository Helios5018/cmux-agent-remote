import type { ReactNode } from "react";
import { APP_NAME_MAX_LENGTH, DEFAULT_HOME_TITLE } from "../appName.ts";
import { useAppStore } from "../stores/AppStore.tsx";
import { RenameMenu } from "./RenameMenu.tsx";

export function TopBar({
  title,
  subtitle,
  onBack,
  onRename,
  renameMaxLength = APP_NAME_MAX_LENGTH,
  renamePlaceholder = DEFAULT_HOME_TITLE,
  renameAriaLabel = "应用名称",
  right,
  onCreate,
  createLabel,
  closeActions,
  fileAction,
}: {
  fileAction?: { label: string; run: () => void };
  closeActions?: { workspace: () => void; pane: () => void };
  onCreate?: () => Promise<unknown>;
  createLabel?: string;
  title: string;
  subtitle?: string;
  onBack?: () => void;
  /** 有这个回调时，在更多操作菜单中提供改名。 */
  onRename?: (name: string) => void;
  renameMaxLength?: number;
  renamePlaceholder?: string;
  renameAriaLabel?: string;
  right?: ReactNode;
}) {
  const { connection } = useAppStore();

  return (
    <header className="topbar">
      {onBack ? (
        <button type="button" className="icon-button" onClick={onBack} aria-label="返回">
          ‹
        </button>
      ) : (
        <span className={`conn conn-${connection}`} title={`WebSocket: ${connection}`} />
      )}
      <div className="topbar-title">
        <div className="topbar-title-main">{title}</div>
        {subtitle ? <div className="topbar-title-sub">{subtitle}</div> : null}
      </div>
      <div className="topbar-right">{right}
        {onRename ? <RenameMenu value={title} onRename={onRename} maxLength={renameMaxLength}
          fileAction={fileAction} closeActions={closeActions} onCreate={onCreate} createLabel={createLabel} label={renameAriaLabel} placeholder={renamePlaceholder} /> : null}
      </div>
    </header>
  );
}
