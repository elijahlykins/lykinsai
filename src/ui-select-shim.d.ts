declare module "@/components/ui/select" {
  import * as React from "react";
  import * as SelectPrimitive from "@radix-ui/react-select";

  export const Select: typeof SelectPrimitive.Root;
  export const SelectGroup: typeof SelectPrimitive.Group;
  export const SelectValue: typeof SelectPrimitive.Value;

  export const SelectTrigger: React.ForwardRefExoticComponent<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> &
      React.RefAttributes<React.ElementRef<typeof SelectPrimitive.Trigger>>
  >;

  export const SelectContent: React.ForwardRefExoticComponent<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> &
      React.RefAttributes<React.ElementRef<typeof SelectPrimitive.Content>>
  >;

  export const SelectLabel: React.ForwardRefExoticComponent<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label> &
      React.RefAttributes<React.ElementRef<typeof SelectPrimitive.Label>>
  >;

  export const SelectItem: React.ForwardRefExoticComponent<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> &
      React.RefAttributes<React.ElementRef<typeof SelectPrimitive.Item>>
  >;

  export const SelectSeparator: React.ForwardRefExoticComponent<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator> &
      React.RefAttributes<React.ElementRef<typeof SelectPrimitive.Separator>>
  >;

  export const SelectScrollUpButton: React.ForwardRefExoticComponent<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton> &
      React.RefAttributes<React.ElementRef<typeof SelectPrimitive.ScrollUpButton>>
  >;

  export const SelectScrollDownButton: React.ForwardRefExoticComponent<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton> &
      React.RefAttributes<React.ElementRef<typeof SelectPrimitive.ScrollDownButton>>
  >;
}

