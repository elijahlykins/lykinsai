"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils";

const Slider = React.forwardRef(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center py-2",
      "data-[disabled]:opacity-40",
      className,
    )}
    {...props}
  >
    <SliderPrimitive.Track className="lg-slider-track relative h-[5px] w-full grow overflow-hidden rounded-full">
      <SliderPrimitive.Range className="lg-slider-range absolute h-full rounded-full" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="lg-slider-thumb block h-[17px] w-[17px] rounded-full focus-visible:outline-none" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
