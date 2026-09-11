import before from "../assets/teaser/before.jpg";
import after from "../assets/teaser/after.jpg";
import sketch from "../assets/teaser/sketch.jpg";
import manipulate from "../assets/teaser/manipulate.jpg";

/** What a visitor sees first: the paper, then the idea, then the tool.
 *
 *  Title, teaser, then the demo. The published link is
 *  shared with reviewers and colleagues who have not read the paper, and
 *  dropping them straight onto a home-size form told them nothing about what
 *  the tool is for. The teaser is a simplified Figure 1: the same three steps
 *  (notice, ask, inspect) with the paper's own screenshots, and none of the
 *  detail a first glance does not need. */
export function TitleScreen({ onExplore }: { onExplore: () => void }) {
  return (
    <div className="title-screen">
      <header className="title-head">
        <p className="title-venue">Research prototype</p>
        <h1>
          FlowWeaver
          <span>Translating Indoor Airflow Needs into Editable Configurations through Multi-Modal Control</span>
        </h1>
        {/* ANONYMOUS FOR REVIEW. CHI review is double-blind and this page is the
            supplementary demo, so it names no authors and no institution. Put
            the author line back only after the paper is accepted. */}
        <p className="title-authors">Anonymous authors · Supplementary material for review</p>
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
            <h2><b>2</b> Express a goal</h2>
            {/* THE THREE MODALITIES, named. The paper's contribution is that
                they combine — words say WHAT, a sketch says WHERE, and direct
                manipulation lets the user just move the thing — so the teaser
                shows all three rather than one text box. */}
            <div className="teaser-ask">
              <div className="teaser-mode">
                <span>Natural language</span>
                <div className="teaser-prompt">Keep the bedroom and living room warm</div>
              </div>
              <div className="teaser-mode">
                <span>Sketch</span>
                <img src={sketch} alt="A sketch marking the bedroom and an arrow from the living room" />
              </div>
              <div className="teaser-mode">
                <span>Direct manipulation</span>
                <img src={manipulate} alt="Dragging a fan to a new spot in the room" />
              </div>
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
          Non-experts describe the air they want in plain words, mark where with a quick sketch, or simply move things in the room. FlowWeaver searches for device
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
