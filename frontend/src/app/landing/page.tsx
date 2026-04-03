"use client";

import { useEffect, useState } from "react";
import GameofLife from "@/components/GameofLife";
import { HeroSection } from "@/components/HeroSection";

export default function LandingPage() {
  const [focalPoint, setFocalPoint] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const updateFocalPoint = () => {
      setFocalPoint({
        x: Math.round(window.innerWidth * 0.58),
        y: Math.round(window.innerHeight * 0.5),
      });
    };

    updateFocalPoint();
    window.addEventListener("resize", updateFocalPoint);

    return () => {
      window.removeEventListener("resize", updateFocalPoint);
    };
  }, []);

  const { x, y } = focalPoint;

  return (
    <main className="landing-page">
      <section className="relative h-screen">
        <GameofLife/>
        <HeroSection/>
      </section>

      <section
        id="product-info"
        className="relative z-10 min-h-screen px-6 py-16 md:px-12"
        style={{ backgroundColor: "rgba(10, 10, 15, 0.88)", backdropFilter: "blur(2px)" }}
      >
        <div className="mx-auto max-w-4xl rounded-2xl border p-8 md:p-12" style={{ borderColor: "rgba(255, 255, 255, 0.16)", backgroundColor: "rgba(255, 255, 255, 0.04)" }}>
          <p className="text-sm font-medium tracking-wide" style={{ color: "#d1d5db" }}>
            Product Overview
          </p>
          <h2 className="mt-3 text-4xl font-bold" style={{ color: "#ffffff" }}>
            Built for teams that merge fast without breaking quality
          </h2>
          <p className="mt-6 text-lg leading-relaxed" style={{ color: "#e5e7eb" }}>
            Kaizen scores every commit and pull request with transparent quality signals so engineering teams can
            reward consistent contributors and catch risky changes early.
          </p>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            <div className="rounded-xl border p-5" style={{ borderColor: "rgba(255, 255, 255, 0.14)", backgroundColor: "rgba(255, 255, 255, 0.03)" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#ffffff" }}>Commit Intelligence</h3>
              <p className="mt-2 text-sm" style={{ color: "#d1d5db" }}>
                Understand impact by combining code quality, context, and velocity across repositories.
              </p>
            </div>
            <div className="rounded-xl border p-5" style={{ borderColor: "rgba(255, 255, 255, 0.14)", backgroundColor: "rgba(255, 255, 255, 0.03)" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#ffffff" }}>Merge Reputation</h3>
              <p className="mt-2 text-sm" style={{ color: "#d1d5db" }}>
                Track reputation that compounds over time, from first contribution to release-critical work.
              </p>
            </div>
            <div className="rounded-xl border p-5" style={{ borderColor: "rgba(255, 255, 255, 0.14)", backgroundColor: "rgba(255, 255, 255, 0.03)" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#ffffff" }}>AI-Aware Insights</h3>
              <p className="mt-2 text-sm" style={{ color: "#d1d5db" }}>
                Evaluate human and agent contributions with the same clear standards and leaderboard metrics.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
