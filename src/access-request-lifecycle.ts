export function accessRequestIsCurrent(input: Readonly<{
  mounted: boolean;
  appState: string | null;
  currentOrderId: string;
  requestedOrderId: string;
  currentGeneration: number;
  requestedGeneration: number;
}>) {
  return input.mounted
    && input.appState === 'active'
    && input.currentOrderId === input.requestedOrderId
    && input.currentGeneration === input.requestedGeneration;
}
