import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

interface IsolatedComposerTextareaProps {
  sessionId: string;
  initialValue: string;
  programmaticNonce: number;
  placeholder: string;
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onLiveChange: (sessionId: string, val: string) => void;
  onCommitDraft: (sessionId: string, val: string) => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
}

/**
 * Isolates high-frequency keystroke state inside the composer textarea so normal
 * typing triggers 0 re-renders of the parent App message stream & sidebar.
 * Programmatic updates (send-clear, voice dictation, slash skills, queued edit-back)
 * sync down cleanly via `programmaticNonce` and `sessionId`.
 */
export const IsolatedComposerTextarea: React.FC<IsolatedComposerTextareaProps> = React.memo(
  ({
    sessionId,
    initialValue,
    programmaticNonce,
    placeholder,
    textareaRef,
    onLiveChange,
    onCommitDraft,
    onPaste,
    onKeyDown,
  }) => {
    const [localValue, setLocalValue] = useState<string>(initialValue);
    const localValueRef = useRef<string>(initialValue);
    localValueRef.current = localValue;

    const prevSessionIdRef = useRef<string>(sessionId);
    const onCommitDraftRef = useRef(onCommitDraft);
    onCommitDraftRef.current = onCommitDraft;
    const initialValueRef = useRef(initialValue);
    initialValueRef.current = initialValue;

    // When switching sessions or receiving a programmatic update (clear/voice/slash/edit-back),
    // commit the previous session's draft for the sidebar badge and adopt the latest value.
    // Deliberately omits `initialValue` from deps so unrelated parent re-renders (e.g. streaming chunks)
    // never overwrite in-progress user typing or cursor position.
    useEffect(() => {
      if (prevSessionIdRef.current !== sessionId) {
        onCommitDraftRef.current(prevSessionIdRef.current, localValueRef.current);
        prevSessionIdRef.current = sessionId;
      }
      setLocalValue(initialValueRef.current);
    }, [sessionId, programmaticNonce]);

    // Flush draft on unmount (e.g. switching into voice dictation mode)
    useEffect(() => {
      return () => {
        onCommitDraftRef.current(prevSessionIdRef.current, localValueRef.current);
      };
    }, []);

    // Smooth auto-growing height (baseline 44px -> max 200px)
    useLayoutEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      const nextHeight = Math.min(200, Math.max(44, el.scrollHeight));
      el.style.height = `${nextHeight}px`;
    }, [localValue, sessionId, textareaRef]);

    return (
      <textarea
        ref={textareaRef}
        rows={1}
        value={localValue}
        onChange={(e) => {
          const val = e.target.value;
          setLocalValue(val);
          onLiveChange(sessionId, val);
        }}
        onBlur={() => {
          onCommitDraftRef.current(sessionId, localValueRef.current);
        }}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="min-h-[44px] max-h-[200px] w-full resize-none overflow-y-auto bg-transparent text-[13.5px] max-md:text-[16px] leading-relaxed text-[var(--v-fg-primary)] placeholder-[var(--v-fg-faint)] focus:outline-none"
      />
    );
  }
);

IsolatedComposerTextarea.displayName = "IsolatedComposerTextarea";
