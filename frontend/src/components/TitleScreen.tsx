import before from "../assets/teaser/before.jpg";
import after from "../assets/teaser/after.jpg";
import sketch from "../assets/teaser/sketch.jpg";

/** What a visitor sees first: the paper, then the idea, then the tool.
 *
 *  Igarashi's order — title, teaser, then the demo. The published link is
 *  shared with reviewers and colleagues who have not read the paper, and
 *  dropping them straight onto a home-size form told them nothing about what
 *  the tool is for. The teaser is a simplified Figure 1: the same three steps
 *  (notice, ask, inspect) with the paper's own screenshots, and none of the
 *  detail a first glance does not need. */
export function TitleScreen({ onExplore }: { onExplore: () => void }) {
  return (
    <div className="title-screen">
      <header className="title-head">
        <p className="title-venue">CHI 2027 · Research prototype</p>
        <h1>
          FlowWeaver
          <span>Translating Indoor Airflow Needs into Editable Configurations through Multi-Modal Control</span>
        </h1>
        <p className="title-authors">
          Joseph Leonard, Hongbo Zhang, Hengyuan Chang, Bo Zhu, Haoran Xie, and Takeo Igarashi
        </p>
      </header>

      <figure className="teaser">
        <div className="teaser-steps">
          <div className="teaser-step">
            <h2><b>1</b> Notice a problem</h2>
            <div className="teaser-shot">
              <img src={before} alt="A two-room home with a cold bedroom" />
            </div>
          </div>

          <div className="teaser-arrow" aria-hidden>→</div>

          <div className="teaser-step">
            <h2><b>2</b> Say it, sketch it, or both</h2>
            <div className="teaser-ask">
              <div className="teaser-prompt">Keep the bedroom and living room warm</div>
              <img src={sketch} alt="A sketch marking the bedroom and an arrow from the living room" />
            </div>
            <p className="teaser-note">Optimization + simulation turn the request into suggestions</p>
          </div>

          <div className="teaser-arrow" aria-hidden>→</div>

          <div className="teaser-step">
            <h2><b>3</b> Inspect and adjust</h2>
            <div className="teaser-shot">
              <img src={after} alt="The same home after the suggestion, with the fan and heater moved" />
            </div>
          </div>
        </div>
        <figcaption>
          Non-experts describe the air they want in plain words or a quick sketch. FlowWeaver searches for device
          placements, simulates the airflow, and offers editable suggestions to inspect and refine.
        </figcaption>
      </figure>

      <button className="title-go" onClick={onExplore}>
        Try the demo →
      </button>
      <p className="title-foot">Runs entirely in your browser — nothing to install.</p>
    </div>
  );
}
