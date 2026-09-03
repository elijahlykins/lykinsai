# Tool: generate_image

Generate a picture: art, a logo, a product shot, a visual design. The image
opens for the user automatically.

## When

Only when the user asked for a visual. "Design a logo" is an image; "design a
landing page" is build_artifact; "describe what the logo should look like" is
a reply.

## Instruction

Write the image brief:

- subject and composition - what is in the frame and how it is arranged
- style: photographic, illustrated, flat, 3D, a named aesthetic
- palette, mood, and any text that must appear (keep text short; long text
  renders badly)
- what the image is FOR, when known - a logo, a hero image, and a meme want
  very different framing

Fold in every visual preference the user stated anywhere in the conversation.

## Rules

- One image per instruction. If the user asked for variations, run the tool
  once per variation with a distinct brief.
- If the user attached a reference image, say in the instruction what to take
  from it (style, subject, layout).
