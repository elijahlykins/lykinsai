import type { SVGProps } from "react";

interface GridIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}

export function GridIcon({ size = 24, className, ...props }: GridIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}
