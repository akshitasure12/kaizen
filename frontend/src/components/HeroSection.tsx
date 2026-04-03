"use client";

import Link from "next/link";

export function HeroSection() {
  const scrollToProductInfo = () => {
    const section = document.getElementById("product-info");
    if (section) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div className="absolute inset-0 pointer-events-none flex items-center justify-start pl-12 pt-5">
      <div className="pointer-events-auto flex flex-col items-start gap-8">
        <div className="flex flex-col gap-2">
        {/* Tagline */}
        <div className="text-center">
          <p
            className="text-sm font-medium"
            style={{ color: "#ffffff", fontSize: "18pt" }}
          >
            [MERGE TO EARN. BREAK NOTHING.]
          </p>
        </div>

        {/* Main Title with Border */}
        <div
          className="text-5xl font-bold"
          style={{ color: "#ffffff", fontSize: "84pt" }}>
            kaizen
        </div>
        </div>
        <div className="flex flex-col gap-4">
        {/* Floating Card */}
        <div
          className="backdrop-blur-sm rounded-lg p-6 w-84 flex flex-col gap-4"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
          }}
        >
          {/* Card Description */}
          <p
            className="text-sm leading-relaxed"
            style={{ color: "#cccccc", fontSize: "12pt" }}
          >
            Every commit is scored. Every merge is rewarded. Reputation compounds.
          </p>
          {/* View More Button */}
          <button
            className="px-4 py-2 rounded-md font-medium transition-all"
            style={{
              fontSize: "12pt",
              color: "#ffffff",
              backgroundColor: "rgba(255, 255, 255, 0.15)",
              border: "1px solid rgba(255, 255, 255, 0.2)",
            }}
            onClick={scrollToProductInfo}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#000000";
              e.currentTarget.style.backgroundColor = "#f0f0f0";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "#ffffff";
              e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.15)";
            }}
          >
            Learn More
          </button>
        </div>

        {/* Try Now Button */}
        <div className="flex justify-center gap-12 w-84">
        <Link
          href="/login"
          className="px-8 py-3 rounded-md font-semibold text-lg transition-all"
          style={{
            fontSize: "12pt",
            color: "#000000",
            backgroundColor: "#ffffff",
            border: "1px solid transparent",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#ffffff";
            e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.15)";
            e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#000000";
            e.currentTarget.style.backgroundColor = "#ffffff";
            e.currentTarget.style.borderColor = "transparent";
          }}
        >
          Try Now
        </Link>
        <Link
          href="/login"
          className="px-8 py-3 rounded-md font-semibold text-lg transition-all"
          style={{
            fontSize: "12pt",
            color: "#ffffff",
            backgroundColor: "rgba(255, 255, 255, 0.15)",
            border: "1px solid rgba(255, 255, 255, 0.2)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#000000";
            e.currentTarget.style.backgroundColor = "#f0f0f0";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#ffffff";
            e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.15)";
          }}
        >
          View Demo
        </Link>
        </div>
        </div>
      </div>
    </div>
  );
}
