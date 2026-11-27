/** Wire shape for rows the rail shows but no agent process owns.
 *
 *  The failure this prevents: `/api/sessions` used to send every cold/archived row with the full ACP
 *  handshakeSnapshot (configOptions / modes / commands / usage / models). On an installation with 211
 *  cold rows that single response was 5.87 MB, and the same payload was ALSO broadcast on WS connect
 *  and on every session-state change. The rail needs none of it: a cold row exists so it can be shown
 *  and woken, and the full snapshot comes back when it is opened or resumed.
 *
 *  Fields are EMPTIED, never deleted: the session view calls `.find()` on `configOptions` as soon as
 *  it renders, and a missing field crashes the page (verified on v0.26.2 baseline too). `pendingModelId`
 *  is kept because a cold slot's chosen model is replayed on resume.
 */
import type { SessionInfo } from "../../shared/src/index.js";

export function wireSession(info: SessionInfo): SessionInfo {
  if (!info.cold) return info; // any row WITH a process keeps its full snapshot — including archived-live rows
  return {
    ...info,
    configOptions: [],
    commands: [],
    modes: null,
    usage: null,
    models: null,
  };
}

export function wireSessions(rows: readonly SessionInfo[]): SessionInfo[] {
  return rows.map(wireSession);
}
