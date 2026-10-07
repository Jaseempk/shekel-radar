import { Composition } from "remotion";
import { Reel } from "./Reel";
import { FPS, TOTAL } from "./tempo";

export const Root: React.FC = () => (
  <Composition id="Reel" component={Reel} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
);
