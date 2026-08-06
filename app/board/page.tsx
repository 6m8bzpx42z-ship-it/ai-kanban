import BeadsBoard from "@/components/BeadsBoard";

/**
 * The board's own page wrapper.
 *
 * This padding is not decoration. The component renders a wide multi-column
 * grid and assumes something around it provides gutters and horizontal
 * scrolling. Dropped into a fresh app with nothing around it, the columns run
 * off the right edge of the window and the first card sits flush against the
 * left — which is exactly what a clean-install check turned up.
 *
 * `overflow-x-auto` matters on a narrow window: five columns will not fit on a
 * laptop screen, and scrolling to them beats squeezing them until the titles
 * are unreadable.
 *
 * If you already have an app shell with its own padded <main>, drop this
 * wrapper and render <BeadsBoard /> straight into it.
 */
export default function BoardPage() {
  return (
    <main className="min-h-screen overflow-x-auto p-6 md:p-8">
      <BeadsBoard />
    </main>
  );
}
