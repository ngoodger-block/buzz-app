import type { ChannelSummary } from "../../features/relay/contracts";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { HashIcon, LockIcon } from "../../shared/design-system/icons";

export function WorkflowChannelPicker({
  channels,
  onSelect,
}: {
  channels: readonly ChannelSummary[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="workflow-channel-picker">
      <Combobox.Root
        items={channels}
        itemToStringLabel={(channel: ChannelSummary) => channel.name}
        itemToStringValue={(channel: ChannelSummary) => channel.id}
        onValueChange={(channel) => {
          if (channel) onSelect(channel.id);
        }}
        defaultOpen
        // Typed text highlights the first match, so Enter picks it.
        autoHighlight
      >
        <Combobox.Control
          label="Choose a channel"
          triggerLabel="Browse channels"
          placeholder="Search channels…"
          autoFocus
        />
        <Combobox.Popup empty="No matching channels.">
          <Combobox.List>
            {(channel: ChannelSummary) => (
              <Combobox.Item key={channel.id} value={channel}>
                <span className="workflow-channel-label">
                  {channel.private ? (
                    <LockIcon size={18} aria-hidden="true" />
                  ) : (
                    <HashIcon size={18} aria-hidden="true" />
                  )}
                  {channel.name}
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </div>
  );
}
