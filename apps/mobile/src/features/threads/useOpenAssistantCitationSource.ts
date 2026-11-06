import type { AssistantCitation } from "@t3tools/contracts";
import { useRoute, type Route } from "@react-navigation/native";
import { Keyboard } from "react-native";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { requestThreadMessageJump } from "./threadMessageJump";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** Opens the cited reply's thread at that reply; the thread screen loads history down to it. */
export function useOpenAssistantCitationSource() {
  const route = useRoute<Route<string, { environmentId?: string; threadId?: string }>>();
  const openLinkedThread = useOpenLinkedThread();
  return (citation: AssistantCitation) => {
    Keyboard.dismiss();
    requestThreadMessageJump(
      scopedThreadKey(citation.environmentId, citation.threadId),
      citation.messageId,
      { citation: true },
    );
    if (
      route.params?.environmentId === citation.environmentId &&
      route.params.threadId === citation.threadId
    ) {
      return;
    }
    openLinkedThread({
      environmentId: String(citation.environmentId),
      threadId: String(citation.threadId),
    });
  };
}
