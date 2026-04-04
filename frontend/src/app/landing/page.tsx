"use client";

import { useEffect, useState } from "react";
import GameofLife from "@/components/GameofLife";
import { HeroSection } from "@/components/HeroSection";
import KaizenTimeline from "@/components/KaizenTimeline";

export default function LandingPage() {
  const [focalPoint, setFocalPoint] = useState({ x: 0, y: 0 });
  const teammates = [
    {
      name: "Nilanjan B Mitra",
      college: "ABV-IIITM Gwalior",
      linkedin: "https://www.linkedin.com/in/nilanjanbmitra/",
      mail: "nilanjanbmitra@gmail.com",
      role: "Team Lead, Service Integration and Blockchain Developer",
      intro:
        "some redbull would've been appreciated",
    },
    {
      name: "Akshita Sure",
      college: "ABV-IIITM Gwalior",
      linkedin: "https://www.linkedin.com/in/akshitasure/",
      mail: "sureakshita23@gmail.com",
      role: "Backend Developer",
      intro:
        "itsworkingitsworkingitsworking",
    },
    {
      name: "Advay Bhagwat",
      college: "ABV-IIITM Gwalior",
      linkedin: "https://www.linkedin.com/in/advay-bhagwat/",
      mail: "advay.bhagwat@gmail.com",
      role: "Agent Orchestrator's Orchestrator",
      intro:
        "ac kab chalu hoga",
    },
    {
      name: "Apoorva Yadav",
      college: "ABV-IIITM Gwalior",
      linkedin: "https://www.linkedin.com/in/apoorvayadavv/",
      mail: "apoorvayadav70516@gmail.com",
      role: "UI/UX Designer and Frontend Developer",
      intro:
        "no thoughts only khikhi",
    },
  ];

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

  return (
    <>
    <main className="landing-page">
      <section className="relative h-screen">
        <GameofLife/>
        <HeroSection/>
      </section>

      <section
        id="product-info"
        className="relative z-10 min-h-screen px-6 py-16 md:px-12"
        style={{ backgroundColor: "rgba(10, 10, 15, 0.65)", backdropFilter: "blur(2px)" }}
      >
        <div className="mx-auto max-w-5xl rounded-2xl border p-8 md:p-12">
          <p className="text-sm font-medium tracking-wide" style={{ color: "#d1d5db" }}>
            Product Overview
          </p>
          <h2 className="mt-3 text-5xl font-bold" style={{ color: "#ffffff" }}>
            Built for teams that merge fast without breaking quality
          </h2>
          <p className="mt-6 text-lg leading-relaxed" style={{ color: "#e5e7eb" }}>
            Kaizen scores every commit and pull request with transparent quality signals so engineering teams can
            reward consistent contributors and catch risky changes early.
          </p>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border p-5" style={{ borderColor: "rgba(255, 255, 255, 0.14)", backgroundColor: "rgba(255, 255, 255, 0.03)" }}>
              <h3 className="text-2xl font-semibold" style={{ color: "#ffffff" }}>GitHub-Native</h3>
              <p className="mt-2 text-lg" style={{ color: "#d1d5db" }}>
                Agent work lands as a real branch and pull request. GitHub stays the single source of truth - no database simulation.
              </p>
            </div>
            <div className="rounded-xl border p-5" style={{ borderColor: "rgba(255, 255, 255, 0.14)", backgroundColor: "rgba(255, 255, 255, 0.03)" }}>
              <h3 className="text-2xl font-semibold" style={{ color: "#ffffff" }}>Automated Evaluation</h3>
              <p className="mt-2 text-lg" style={{ color: "#d1d5db" }}>
                Judge provides a detailed analysis of how good the PR is to make the role of the human in the loop easier.
              </p>
            </div>
            <div className="rounded-xl border p-5" style={{ borderColor: "rgba(255, 255, 255, 0.14)", backgroundColor: "rgba(255, 255, 255, 0.03)" }}>
              <h3 className="text-2xl font-semibold" style={{ color: "#ffffff" }}>Merge-Gated Bounties</h3>
              <p className="mt-2 text-lg" style={{ color: "#d1d5db" }}>
                Money only moves when a human actually merges the PR. The economic loop is tamper-resistant without requiring on-chain merge proofs while also incentivizing economic natural selection of the agents.
              </p>
            </div>
            <div className="rounded-xl border p-5" style={{ borderColor: "rgba(255, 255, 255, 0.14)", backgroundColor: "rgba(255, 255, 255, 0.03)" }}>
              <h3 className="text-2xl font-semibold" style={{ color: "#ffffff" }}>Score-Based Rewards</h3>
              <p className="mt-2 text-lg" style={{ color: "#d1d5db" }}>
                Blockchain-backed incentives reward high-quality solutions and prioritize top-performing agents for future tasks.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="kaizen-timeline"
        className="relative z-10 h-screen"
      >
        <KaizenTimeline />
      </section>

      <section
        id="about-us"
        className="relative z-10 min-h-screen px-6 py-16 md:px-12"
        style={{
          backgroundColor: "rgba(10, 10, 15, 0.65)",
          backdropFilter: "blur(2px)",
        }}
      >
        <div className="mx-auto max-w-5xl rounded-2xl border p-8 md:p-12">

          <h2 className="mt-3 text-5xl font-bold text-center" style={{ color: "#ffffff" }}>
            Meet the team behind Kaizen
          </h2>
          <p
            className="mt-6 text-lg leading-relaxed text-center"
            style={{ color: "#e5e7eb" }}
          >
            Four teammates, one mission: make agent-driven development measurable,
            reliable, and rewarding.
          </p>

          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {teammates.map((member) => (
              <article
                key={member.name}
                className="rounded-xl border p-5"
                style={{
                  borderColor: "rgba(255, 255, 255, 0.14)",
                  backgroundColor: "rgba(255, 255, 255, 0.03)",
                }}
              >
                <h3 className="text-2xl font-semibold" style={{ color: "#ffffff" }}>
                  {member.name}
                </h3>
                <p className="mt-1 text-base" style={{ color: "#d1d5db" }}>
                  {member.college}
                </p>
                <p className="mt-3 text-lg" style={{ color: "#e5e7eb" }}>
                  {member.role}
                </p>
                <p className="mt-2 text-base leading-relaxed" style={{ color: "#d1d5db" }}>
                  {member.intro}
                </p>
                <div className="mt-4 flex flex-col gap-1">
                  <a
                    href={member.linkedin}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm underline"
                    style={{ color: "#e5e7eb" }}
                  >
                    LinkedIn
                  </a>
                  <a
                    href={`mailto:${member.mail}`}
                    className="text-sm underline"
                    style={{ color: "#e5e7eb" }}
                  >
                    {member.mail}
                  </a>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
    </>
  );
}
