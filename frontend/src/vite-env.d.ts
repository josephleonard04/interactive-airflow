/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional URL that a submitted session report is POSTed to. Set it at build
   *  time (VITE_LOG_ENDPOINT=... npm run build) to collect sessions from people
   *  running the app somewhere else; leave it unset and Submit just downloads
   *  the report to the participant's own machine. */
  readonly VITE_LOG_ENDPOINT?: string;
  /** Where a participant should email their session. Set it and Submit opens
   *  their mail client with the message already written, so all they do is
   *  attach the file it just downloaded and press send.
   *
   *  Put it in frontend/.env.local, which is gitignored — an address committed
   *  to a public repo is an address in a scraper's list. */
  readonly VITE_RESEARCHER_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
