import type { StateContext } from '../../../../src/runtime';

// "Start with: fresh demo data".
// Dintel keeps its data in the browser (localStorage), and every HumanTest user gets a brand new
// browser, so the app seeds its demo data by itself. Nothing to do here, for now.
// When Dintel gets a real backend (Node + PostgreSQL), this is where the test database gets reset.
export default async function (_ctx: StateContext) {}
