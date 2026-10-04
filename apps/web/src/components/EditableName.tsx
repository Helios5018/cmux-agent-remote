import { useEffect, useRef, useState } from "react";

export function EditableName({
  value,
  onRename,
  className = "",
  inputClassName = "",
  placeholder,
  maxLength,
  ariaLabel = "名称",
  title = "点击修改名称",
}: {
  value: string;
  onRename?: (name: string) => void;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  maxLength: number;
  ariaLabel?: string;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipCommit = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const element = inputRef.current;
    if (!element) return;
    element.focus();
    element.select();
  }, [editing]);

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      setDraft(value);
      setEditing(false);
      return;
    }
    if (!onRename) return;
    onRename(draft);
    setEditing(false);
  };

  const cancel = () => {
    skipCommit.current = true;
    setDraft(value);
    inputRef.current?.blur();
  };

  if (editing && onRename) {
    return (
      <input
        ref={inputRef}
        className={inputClassName}
        value={draft}
        size={Math.max(draft.length, placeholder?.length ?? 0, 3)}
        maxLength={maxLength}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !composing) {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      />
    );
  }

  if (onRename) {
    return (
      <button
        type="button"
        className={className}
        title={title}
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }

  return <div className={className}>{value}</div>;
}
