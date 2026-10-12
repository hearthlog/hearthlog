import { WorkerEntrypoint } from "cloudflare:workers";
import type { FeedRenderer, RenderedFeed } from "@hearthlog/contracts/calendar/feed-contract";
import { renderCalendarFeed } from "./calendar-feeds";

/**
 * The only door the public feed Worker has into this site. It is reachable
 * through a service binding alone, takes a feed token and nothing else, and
 * answers with the rendered feed; the Ledger credential never leaves this Worker.
 */
export class CalendarFeedRenderer extends WorkerEntrypoint<Env> implements FeedRenderer {
    renderFeed(token: string, headOnly: boolean): Promise<RenderedFeed> {
        return renderCalendarFeed(String(token), Boolean(headOnly), this.env);
    }
}
