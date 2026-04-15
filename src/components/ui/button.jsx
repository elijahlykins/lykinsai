import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border shadow-sm shadow-black/5 dark:shadow-black/30 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-white/45 text-foreground border-white/30 hover:bg-white/60 dark:bg-white/12 dark:text-foreground dark:border-white/12 dark:hover:bg-white/16",
        destructive:
          "bg-red-500/18 text-red-700 border-red-500/25 hover:bg-red-500/26 dark:bg-red-500/18 dark:text-red-200 dark:border-red-500/25 dark:hover:bg-red-500/24",
        outline:
          "bg-white/25 text-foreground border-white/35 hover:bg-white/38 dark:bg-white/8 dark:text-foreground dark:border-white/12 dark:hover:bg-white/12",
        secondary:
          "bg-white/30 text-foreground border-white/25 hover:bg-white/45 dark:bg-white/10 dark:text-foreground dark:border-white/10 dark:hover:bg-white/14",
        ghost:
          "bg-transparent text-foreground border-transparent shadow-none hover:bg-white/25 hover:border-white/20 dark:hover:bg-white/10 dark:hover:border-white/10",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  );
});

Button.displayName = "Button";

export { Button, buttonVariants };