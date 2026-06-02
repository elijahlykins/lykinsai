const WAKE_INTRO_TAGLINE_WORDS = ["CREATE", "BEYOND", "YOURSELF"] as const;

export default function WakeIntroTagline({ className }: { className?: string }) {
  return (
    <p className={className} aria-label="Create beyond yourself">
      {WAKE_INTRO_TAGLINE_WORDS.map((word) => (
        <span key={word} className="lykn-wake-tagline-word">
          {word.split("").map((letter, index) => (
            <span
              key={`${word}-${index}`}
              className="lykn-wake-tagline-letter"
            >
              {letter}
            </span>
          ))}
        </span>
      ))}
    </p>
  );
}
