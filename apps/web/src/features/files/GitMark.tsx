import type { GitMark as Mark } from "@car/protocol";
import { markLabels } from "./git-state.ts";
const signs: Record<Mark, string> = { ignored: "\uf474", untracked: "?", unstaged: "\uf459", staged: "\uf459", added: "\uf457", deleted: "\uf458", updated: "\uf459" };
export function GitMark({ mark }: { mark: Mark | null }) {
  return mark ? <span className={`git-mark git-mark-${mark}`} title={markLabels[mark]} aria-label={markLabels[mark]}>{signs[mark]}</span> : null;
}
