import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { BAR, BEAT, BPM, C, FPS, MONO, SANS, beat, inOut, t } from "./tempo";

// ---------- shared pieces ----------

/** A word that rises out of a mask. */
const Rise: React.FC<{ at: number; children: React.ReactNode; color?: string }> = ({ at, children, color }) => {
  const p = t(useCurrentFrame(), at, 1.25);
  return (
    <span style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", padding: "0 0.04em 0.14em", margin: "0 -0.04em -0.14em", color }}>
      <span style={{ display: "inline-block", transform: `translateY(${(1 - p) * 112}%) rotate(${(1 - p) * 5}deg)` }}>{children}</span>
    </span>
  );
};

/** Enter from a small offset with a fade. */
const In: React.FC<{ at: number; dy?: number; dx?: number; len?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({
  at, dy = 24, dx = 0, len = 1, style, children,
}) => {
  const p = t(useCurrentFrame(), at, len);
  return <div style={{ opacity: p, transform: `translate(${(1 - p) * dx}px, ${(1 - p) * dy}px)`, ...style }}>{children}</div>;
};

const StageTitle: React.FC<{ n: string; word: string; sub: string; color: string; accent: string }> = ({ n, word, sub, color, accent }) => (
  <div style={{ position: "absolute", left: 160, top: 360, width: 760 }}>
    <In at={0} dy={10} len={0.75}>
      <div style={{ font: `400 24px ${MONO}`, letterSpacing: "0.08em", color: accent }}>{n}</div>
    </In>
    <div style={{ font: `500 188px/1.02 ${SANS}`, letterSpacing: "-0.075em", color, marginTop: 18 }}>
      <Rise at={0}>{word}</Rise>
    </div>
    <In at={0.75} dy={12}>
      <div style={{ font: `400 24px/1.5 ${MONO}`, letterSpacing: "0.06em", color: accent, marginTop: 30, textTransform: "uppercase" }}>{sub}</div>
    </In>
  </div>
);

/** A punchy scale on the downbeat of every bar. */
const Punch: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const s = interpolate(useCurrentFrame(), [0, 9], [1.035, 1], { extrapolateRight: "clamp", easing: inOut });
  return <AbsoluteFill style={{ transform: `scale(${s})` }}>{children}</AbsoluteFill>;
};

const Check: React.FC<{ size?: number; color?: string; bg?: string }> = ({ size = 34, color = C.green, bg = "#e3f8ef" }) => (
  <div style={{ width: size, height: size, borderRadius: "50%", background: bg, display: "grid", placeItems: "center", flexShrink: 0 }}>
    <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24">
      <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </div>
);

// ---------- scenes ----------

const Title: React.FC = () => {
  const f = useCurrentFrame();
  const strike = t(f, 2.25, 0.75, inOut);
  const wipe = t(f, 7.25, 0.75, inOut);
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <div style={{ position: "absolute", left: 160, top: 250, font: `500 210px/1.04 ${SANS}`, letterSpacing: "-0.075em", color: C.ink }}>
        <div>
          <Rise at={0}>Less</Rise>{" "}
          <span style={{ position: "relative", display: "inline-block" }}>
            <Rise at={0.5} color={interpolate(strike, [0, 1], [0, 1]) > 0.5 ? "#a3a8b3" : C.ink}>busywork.</Rise>
            <span style={{ position: "absolute", left: "0.02em", right: "0.1em", top: "0.56em", height: "0.065em", background: C.blue, transform: `scaleX(${strike})`, transformOrigin: "left" }} />
          </span>
        </div>
        <div style={{ color: C.blue }}>
          <Rise at={4}>More</Rise> <Rise at={5}>good</Rise> <Rise at={6}>work.</Rise>
        </div>
      </div>
      <AbsoluteFill style={{ background: C.navy, transform: `translateX(${(1 - wipe) * -100}%)` }} />
    </AbsoluteFill>
  );
};

const COMPANIES: [string, string, number][] = [
  ["Northstar Studio", "N", 94],
  ["Fieldwork", "f.", 87],
  ["Common Ground", "cg", 62],
];

const Source: React.FC = () => {
  const f = useCurrentFrame();
  const dots: React.ReactNode[] = [];
  const GAP = 40;
  for (let y = 20; y < 1080; y += GAP) {
    for (let x = 20; x < 1920; x += GAP) {
      const bend = Math.sin(y * 0.011 + f * 0.05) * 1.6;
      const wave = Math.pow(Math.max(0, Math.sin(x * 0.006 - f * 0.16 + bend)), 12);
      const kick = Math.pow(1 - ((f / BEAT) % 1), 4) * 0.3;
      const k = Math.min(1, wave * (0.8 + kick)) * Math.min(1, Math.max(0.12, (x - 700) / 500));
      dots.push(<circle key={`${x}-${y}`} cx={x} cy={y} r={2 + k * 3} fill={k > 0.05 ? C.mint : "#34466b"} opacity={(0.5 + k * 0.5) * Math.min(1, Math.max(0.35, (x - 500) / 600))} />);
    }
  }
  const chips: [number, number][] = [[1160, 250], [1420, 500], [1180, 740]];
  return (
    <AbsoluteFill style={{ background: C.navy }}>
      <Punch>
        <svg width={1920} height={1080} style={{ position: "absolute" }}>{dots}</svg>
        <StageTitle n="01 / SOURCE" word="Source." sub="Your sources · on a schedule" color="#fff" accent="#9fb0d6" />
        {chips.map(([x, y], i) => {
          const p = t(f, 1 + i * 0.75, 1);
          const ping = t(f, 1 + i * 0.75, 1.5);
          return (
            <div key={i} style={{ position: "absolute", left: x, top: y }}>
              <div style={{ position: "absolute", left: -40, top: -40, width: 80, height: 80, borderRadius: "50%", border: `2px solid ${C.mint}`, opacity: (1 - ping) * (ping > 0 ? 1 : 0), transform: `scale(${0.3 + ping * 2})` }} />
              <div style={{ opacity: p, transform: `translateY(${(1 - p) * 30}px)`, display: "flex", alignItems: "center", gap: 18, background: "#fff", borderRadius: 18, padding: "18px 28px 18px 18px", boxShadow: "0 30px 60px -30px #0008" }}>
                <div style={{ width: 56, height: 56, borderRadius: 14, background: "#eaefff", color: "#334ba4", font: `500 28px/56px ${SANS}`, textAlign: "center", letterSpacing: "-0.08em" }}>{COMPANIES[i][1]}</div>
                <div style={{ font: `500 34px ${SANS}`, letterSpacing: "-0.03em", color: C.ink }}>{COMPANIES[i][0]}</div>
              </div>
            </div>
          );
        })}
      </Punch>
    </AbsoluteFill>
  );
};

const Enrich: React.FC = () => {
  const fields: [string, string][] = [
    ["Industry", "B2B services"],
    ["Team size", "50–100 people"],
    ["Buying signal", "Growing sales team"],
  ];
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <Punch>
        <StageTitle n="02 / ENRICH" word="Enrich." sub="Context your team would dig for" color={C.ink} accent={C.blue} />
        <In at={0.25} dy={40} style={{ position: "absolute", left: 1040, top: 210, width: 720 }}>
          <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 28, padding: 44, boxShadow: "0 40px 90px -50px #1b274d55" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 24, paddingBottom: 32, borderBottom: "1px solid #e8ecf0" }}>
              <div style={{ width: 88, height: 88, borderRadius: 22, background: "#eaefff", color: "#334ba4", font: `500 50px/88px ${SANS}`, textAlign: "center", letterSpacing: "-0.1em" }}>N</div>
              <div>
                <div style={{ font: `500 44px ${SANS}`, letterSpacing: "-0.035em", color: C.ink }}>Northstar Studio</div>
                <div style={{ font: `400 26px ${SANS}`, color: "#778192" }}>northstar.example</div>
              </div>
            </div>
            {fields.map(([k, v], i) => (
              <In key={k} at={1 + i * 0.75} dy={14} len={0.75}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr auto", alignItems: "center", gap: 16, padding: "22px 0", borderBottom: i < 2 ? "1px solid #f0f2f5" : "none", font: `400 30px ${SANS}` }}>
                  <span style={{ color: "#737c8c" }}>{k}</span>
                  <span style={{ color: C.ink }}>{v}</span>
                  <Check />
                </div>
              </In>
            ))}
          </div>
        </In>
      </Punch>
    </AbsoluteFill>
  );
};

const Score: React.FC = () => {
  const f = useCurrentFrame();
  const fill = t(f, 0.5, 2);
  const box = t(f, 0.5, 1);
  const R = 190;
  const circ = 2 * Math.PI * R;
  const rot = interpolate(box, [0, 1], [-14, 0]);
  return (
    <AbsoluteFill style={{ background: C.blue }}>
      <Punch>
        <StageTitle n="03 / SCORE" word="Score." sub="A reason behind every number" color="#fff" accent="#cdd5ff" />
        <div style={{ position: "absolute", left: 1180, top: 290, width: 500, height: 500 }}>
          <svg width={500} height={500} style={{ transform: "rotate(-90deg)" }}>
            <circle cx={250} cy={250} r={R} fill="none" stroke="#ffffff30" strokeWidth={14} />
            <circle cx={250} cy={250} r={R} fill="none" stroke="#fff" strokeWidth={14} strokeLinecap="round" strokeDasharray={`${circ * 0.94 * fill} ${circ}`} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center", color: "#fff" }}>
            <div>
              <div style={{ font: `500 170px/1 ${SANS}`, letterSpacing: "-0.05em", fontVariantNumeric: "tabular-nums" }}>{Math.round(94 * fill)}</div>
              <div style={{ font: `400 22px ${MONO}`, letterSpacing: "0.1em", marginTop: 10, color: "#dfe4ff" }}>FIT SCORE</div>
            </div>
          </div>
          <div style={{ position: "absolute", inset: -24, border: "2px solid #fff", opacity: box, transform: `rotate(${rot}deg) scale(${1.2 - box * 0.2})` }}>
            {[[-9, -9], [-9, null], [null, -9], [null, null]].map(([l, tp], i) => (
              <div key={i} style={{ position: "absolute", width: 16, height: 16, background: C.blue, border: "2px solid #fff", left: l ?? undefined, right: l === null ? -9 : undefined, top: tp ?? undefined, bottom: tp === null ? -9 : undefined }} />
            ))}
            <div style={{ position: "absolute", left: -2, top: -64, background: "#fff", color: C.blue, font: `400 22px/1 ${MONO}`, letterSpacing: "0.07em", padding: "12px 14px", whiteSpace: "nowrap" }}>
              SCORE {Math.round(94 * fill)} · SIGNALS {Math.min(3, Math.floor(fill * 3.2))}/3 · ROT {rot.toFixed(1)}°
            </div>
          </div>
        </div>
      </Punch>
    </AbsoluteFill>
  );
};

const Deliver: React.FC = () => {
  const f = useCurrentFrame();
  const sort = t(f, 1, 1.25, inOut);
  const ROW = 128;
  // Rows start in arrival order (62, 87, 94) and settle ranked by fit.
  const from = [2, 1, 0];
  return (
    <AbsoluteFill style={{ background: C.ink }}>
      <Punch>
        <StageTitle n="04 / DELIVER" word="Deliver." sub="Ranked · straight into your CRM" color="#fff" accent="#9aa3b8" />
        <In at={0} dy={40} style={{ position: "absolute", left: 1040, top: 220, width: 720 }}>
          <div style={{ background: "#232733", borderRadius: 28, padding: "30px 36px", border: "1px solid #313645" }}>
            <div style={{ font: `400 20px ${MONO}`, letterSpacing: "0.08em", color: "#8d94a6", display: "flex", justifyContent: "space-between", paddingBottom: 18 }}>
              <span>COMPANY</span>
              <span>CUSTOMER FIT</span>
            </div>
            <div style={{ position: "relative", height: ROW * 3 }}>
              {COMPANIES.map(([name, mark, fit], i) => {
                const y = interpolate(sort, [0, 1], [from[i] * ROW, i * ROW]);
                const bar = t(f, 0.25 + i * 0.25, 1.5);
                return (
                  <div key={name} style={{ position: "absolute", left: 0, right: 0, top: y, height: ROW, display: "flex", alignItems: "center", gap: 22, borderTop: "1px solid #313645" }}>
                    <div style={{ width: 64, height: 64, borderRadius: 16, background: i === 0 ? C.blue : "#343a4b", color: "#fff", font: `500 30px/64px ${SANS}`, textAlign: "center", letterSpacing: "-0.08em" }}>{mark}</div>
                    <div style={{ flex: 1, font: `500 34px ${SANS}`, letterSpacing: "-0.03em", color: "#fff" }}>{name}</div>
                    <div style={{ width: 190 }}>
                      <div style={{ font: `500 34px ${SANS}`, color: "#fff", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(fit * bar)}</div>
                      <div style={{ height: 8, background: "#343a4b", borderRadius: 4, marginTop: 8 }}>
                        <div style={{ height: 8, borderRadius: 4, background: i === 0 ? C.mint : "#8b95b8", width: `${fit * bar}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </In>
        <In at={2.75} dy={-20} style={{ position: "absolute", left: 1040, top: 760, width: 720 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 22, background: "#263e40", border: "1px solid #426459", borderRadius: 20, padding: "24px 30px", color: "#cbfbe9" }}>
            <Check size={48} color="#1c5d45" bg="#a4f1d2" />
            <div>
              <div style={{ font: `500 32px ${SANS}` }}>Added to your CRM</div>
              <div style={{ font: `400 24px ${SANS}`, color: "#b8d7ce" }}>Enriched. Ranked. Ready for your team.</div>
            </div>
          </div>
        </In>
      </Punch>
    </AbsoluteFill>
  );
};

const Answer: React.FC = () => {
  const f = useCurrentFrame();
  const q = "What happens after a client signs?";
  const typed = Math.round(q.length * t(f, 0, 1.25, (x) => x));
  const retrieve = t(f, 1.25, 1, inOut);
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <Punch>
        <StageTitle n="05 / ANSWER" word="Answer." sub="Grounded in your documents" color={C.ink} accent={C.blue} />
        <div style={{ position: "absolute", left: 1040, top: 220, width: 720 }}>
          <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 22, padding: "28px 32px", font: `400 32px ${SANS}`, color: C.ink, boxShadow: "0 30px 70px -50px #1b274d55", minHeight: 42 }}>
            {q.slice(0, typed)}
            <span style={{ opacity: typed < q.length || Math.floor(f / (BEAT / 2)) % 2 ? 1 : 0, color: C.blue }}>|</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 18, margin: "34px 4px", font: `400 22px ${MONO}`, letterSpacing: "0.06em", color: C.muted }}>
            <div style={{ width: 160, height: 6, background: C.line, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${retrieve * 100}%`, height: "100%", background: C.blue }} />
            </div>
            SEARCHING 6,300 FILES
          </div>
          <In at={2.25} dy={18}>
            <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 22, padding: "30px 32px", font: `400 34px/1.45 ${SANS}`, letterSpacing: "-0.015em", color: C.ink }}>
              Start with a kickoff, collect the brief, then assign an owner for each deliverable.
              <sup style={{ color: C.blue, fontSize: 22 }}> 1, 2</sup>
            </div>
          </In>
          <div style={{ display: "flex", gap: 16, marginTop: 22 }}>
            {["Onboarding playbook", "Project checklist"].map((s, i) => (
              <In key={s} at={3 + i * 0.25} dy={14} len={0.75}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#eef0ff", color: "#2439dd", borderRadius: 12, padding: "12px 18px", font: `400 24px ${SANS}` }}>
                  <b style={{ font: `500 20px ${MONO}` }}>{i + 1}</b>
                  {s}
                </div>
              </In>
            ))}
          </div>
        </div>
      </Punch>
    </AbsoluteFill>
  );
};

const End: React.FC = () => {
  const f = useCurrentFrame();
  const letters = "jaseem".split("");
  const dot = t(f, 1, 0.75);
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <div style={{ position: "absolute", left: 160, top: 250, font: `500 300px/1 ${SANS}`, letterSpacing: "-0.075em", color: C.ink }}>
        {letters.map((l, i) => (
          <Rise key={i} at={i * 0.125}>{l}</Rise>
        ))}
        <span style={{ display: "inline-block", color: C.blue, transform: `translateY(${(1 - dot) * -260}px)`, opacity: dot }}>.</span>
      </div>
      <In at={1.5} dy={16} style={{ position: "absolute", left: 172, top: 600 }}>
        <div style={{ font: `400 26px ${MONO}`, letterSpacing: "0.1em", color: C.muted }}>AUTOMATION ENGINEER · LEAD SYSTEMS · INTERNAL KNOWLEDGE</div>
      </In>
      <In at={2} dy={16} style={{ position: "absolute", left: 168, top: 668 }}>
        <div style={{ font: `500 64px ${SANS}`, letterSpacing: "-0.05em", color: C.ink }}>
          Less busywork. <span style={{ color: C.blue }}>More good work.</span>
        </div>
      </In>
      <In at={2.75} dy={16} style={{ position: "absolute", left: 172, top: 800 }}>
        <div style={{ font: `400 28px ${MONO}`, letterSpacing: "0.04em", color: C.blue }}>jaseem.co</div>
      </In>
    </AbsoluteFill>
  );
};

// ---------- persistent HUD ----------

const DARK = [false, false, true, false, true, true, false, false];
const STAGE = ["INTRO", "INTRO", "01 SOURCE", "02 ENRICH", "03 SCORE", "04 DELIVER", "05 ANSWER", "END CARD"];

const Hud: React.FC = () => {
  const f = useCurrentFrame();
  const bar = Math.min(7, Math.floor(f / BAR));
  const beatInBar = Math.floor((f - bar * BAR) / BEAT);
  const color = DARK[bar] ? "#ffffffb0" : "#1b1e2599";
  const secs = Math.floor(f / FPS);
  const frames = f % FPS;
  const text: React.CSSProperties = { position: "absolute", font: `400 20px ${MONO}`, letterSpacing: "0.1em", color, whiteSpace: "nowrap" };
  const crop = (s: React.CSSProperties) => <div style={{ position: "absolute", width: 28, height: 28, borderColor: color, borderStyle: "solid", borderWidth: 0, ...s }} />;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {crop({ left: 48, top: 48, borderTopWidth: 2, borderLeftWidth: 2 })}
      {crop({ right: 48, top: 48, borderTopWidth: 2, borderRightWidth: 2 })}
      {crop({ left: 48, bottom: 48, borderBottomWidth: 2, borderLeftWidth: 2 })}
      {crop({ right: 48, bottom: 48, borderBottomWidth: 2, borderRightWidth: 2 })}
      <div style={{ ...text, left: 96, top: 64 }}>JASEEM / SYSTEMS REEL 2026</div>
      <div style={{ ...text, right: 96, top: 64, display: "flex", alignItems: "center", gap: 18 }}>
        <span style={{ display: "flex", gap: 6 }}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} style={{ width: 10, height: 10, background: i === beatInBar ? (DARK[bar] ? C.mint : C.blue) : "transparent", border: `2px solid ${color}` }} />
          ))}
        </span>
        BAR {bar + 1}/8 · {BPM} BPM
      </div>
      <div style={{ ...text, left: 96, bottom: 64 }}>{STAGE[bar]}</div>
      <div style={{ ...text, right: 96, bottom: 64, fontVariantNumeric: "tabular-nums" }}>
        00:{String(secs).padStart(2, "0")}:{String(frames).padStart(2, "0")}
      </div>
    </AbsoluteFill>
  );
};

export const Reel: React.FC = () => {
  const at = (bar: number) => Math.round(bar * BAR);
  const len = (bars: number, from: number) => at(from + bars) - at(from);
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <Sequence from={at(0)} durationInFrames={len(2, 0)}><Title /></Sequence>
      <Sequence from={at(2)} durationInFrames={len(1, 2)}><Source /></Sequence>
      <Sequence from={at(3)} durationInFrames={len(1, 3)}><Enrich /></Sequence>
      <Sequence from={at(4)} durationInFrames={len(1, 4)}><Score /></Sequence>
      <Sequence from={at(5)} durationInFrames={len(1, 5)}><Deliver /></Sequence>
      <Sequence from={at(6)} durationInFrames={len(1, 6)}><Answer /></Sequence>
      <Sequence from={at(7)} durationInFrames={len(1, 7)}><End /></Sequence>
      <Hud />
    </AbsoluteFill>
  );
};

export { beat };
