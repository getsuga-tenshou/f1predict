import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  // Inverted ink in both modes: surface text on primary ink (19.2:1 light, 15.2:1 dark).
  primary: "bg-ink-1 text-surface hover:opacity-90 disabled:opacity-45",
  secondary: "border border-ink-3 bg-surface text-ink-1 hover:bg-tint disabled:opacity-45",
  ghost: "text-ink-2 hover:bg-tint hover:text-ink-1 disabled:opacity-45",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", size = "md", icon, className = "", children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control font-medium transition-[background-color,opacity,transform] duration-150 active:not-disabled:translate-y-px disabled:cursor-not-allowed ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  label: string;
  icon: ReactNode;
  size?: "sm" | "md";
}

/** Square icon-only button; `label` is its accessible name (and native tooltip). */
export function IconButton({ label, icon, size = "md", className = "", type = "button", ...rest }: IconButtonProps) {
  const dim = size === "sm" ? "size-7" : "size-8";
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-control text-ink-2 transition-[background-color,transform] duration-150 hover:bg-tint hover:text-ink-1 active:not-disabled:translate-y-px disabled:cursor-not-allowed disabled:opacity-35 ${dim} ${className}`}
      {...rest}
    >
      {icon}
    </button>
  );
}
