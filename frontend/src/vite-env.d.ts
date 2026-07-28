/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional URL that a submitted session report is POSTed to. Set it at build
   *  time (VITE_LOG_ENDPOINT=... npm run build) to collect sessions from people
   *  running the app somewhere else; leave it unset and Submit just downloads
   *  the report to the participant's own machine. */
  readonly VITE_LOG_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
