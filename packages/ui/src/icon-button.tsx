import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: ReactNode;
  label: string;
  tone?: "default" | "danger";
}

export function IconButton({
  className = "",
  icon,
  label,
  tone = "default",
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={`ui-icon-button ui-icon-button--${tone} ${className}`.trim()}
      title={label}
      type={type}
      {...props}
    >
      {icon}
    </button>
  );
}
