import { useRef, useState } from "react";

interface Props {
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  initial: number;
  onResize: (width: number) => void;
}

/** Pointer capture keeps resizing stable even when the cursor leaves the divider. */
export function PanelDivider({
  side,
  width,
  min,
  max,
  initial,
  onResize,
}: Props) {
  const start = useRef({ x: 0, width });
  const [dragging, setDragging] = useState(false);
  const direction = side === "left" ? 1 : -1;
  const resize = (next: number) =>
    onResize(Math.round(Math.min(max, Math.max(min, next))));
  return (
    <div
      className={`panel-divider panel-divider--${side}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-label={side === "left" ? "调整导航栏宽度" : "调整详情栏宽度"}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整宽度，双击恢复；方向键微调"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        resize(
          start.current.width + (event.clientX - start.current.x) * direction,
        );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => resize(initial)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        if (event.key === "Home") resize(min);
        else if (event.key === "End") resize(max);
        else
          resize(width + (event.key === "ArrowRight" ? 10 : -10) * direction);
      }}
    />
  );
}
