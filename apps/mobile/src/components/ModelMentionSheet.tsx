import type { ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChoiceRow } from "../features/threads/ThreadSettingsRows";
import type { SelectableMarkdownModel } from "../native/SelectableMarkdownText.types";
import { AppText as Text } from "./ui/AppText";
import { Sheet } from "./ui/Sheet";
import { ThemedSwitch } from "./ui/ThemedSwitch";

/** Edits the options a model mention carries, with the controls of the model picker. */
export function ModelMentionSheet(props: {
  readonly model: SelectableMarkdownModel;
  readonly onChangeOptions: (options: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const descriptors = props.model.capabilities
    ? getProviderOptionDescriptors({
        caps: props.model.capabilities,
        selections: props.model.options,
      })
    : [];
  const change = (id: string, value: string | boolean) =>
    props.onChangeOptions(
      props.model.options.some((option) => option.id === id)
        ? props.model.options.map((option) => (option.id === id ? { id, value } : option))
        : [...props.model.options, { id, value }],
    );
  return (
    <Sheet title={props.model.label} onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          gap: 16,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        <Text className="text-sm text-foreground-muted">{props.model.providerLabel}</Text>
        {descriptors.map((descriptor) =>
          descriptor.type === "select" ? (
            <View key={descriptor.id} className="gap-1">
              <Text className="text-xs text-foreground-muted">{descriptor.label}</Text>
              <View className="overflow-hidden rounded-2xl bg-grouped-card">
                {descriptor.options.map((choice, index) => (
                  <ChoiceRow
                    key={choice.id}
                    label={choice.label}
                    {...(choice.description ? { description: choice.description } : {})}
                    selected={getProviderOptionCurrentValue(descriptor) === choice.id}
                    isLast={index === descriptor.options.length - 1}
                    onPress={() => change(descriptor.id, choice.id)}
                  />
                ))}
              </View>
            </View>
          ) : (
            <View
              key={descriptor.id}
              className="min-h-11 flex-row items-center justify-between rounded-2xl bg-grouped-card px-4 py-1"
            >
              <Text className="text-sm font-t3-medium text-foreground">{descriptor.label}</Text>
              <ThemedSwitch
                accessibilityLabel={descriptor.label}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => change(descriptor.id, value)}
              />
            </View>
          ),
        )}
      </ScrollView>
    </Sheet>
  );
}
