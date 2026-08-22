/** Official OpenCode window mark. Inline so BB theme `currentColor` reaches it. */
export function OpenCodeProviderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="-72 -42 384 384"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <title>OpenCode</title>
      <path
        d="M180 240H60V120H180V240Z"
        fill="currentColor"
        fillOpacity={0.45}
      />
      <path
        d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z"
        fill="currentColor"
      />
    </svg>
  );
}
