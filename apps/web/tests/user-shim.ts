import { act, fireEvent } from "@testing-library/react";

/**
 * Subconjunto de @testing-library/user-event com fireEvent: o projeto não
 * tem essa dependência e a edição de aluno não ganha pacote novo por causa
 * de teste. Cobre só o que as telas de Conversões precisam.
 */
export function setupUser() {
  return {
    async click(element: Element) {
      await act(async () => {
        fireEvent.click(element);
      });
    },
    async type(element: Element, text: string) {
      const enter = text.endsWith("{Enter}");
      const value = enter ? text.slice(0, -"{Enter}".length) : text;
      await act(async () => {
        fireEvent.change(element, { target: { value } });
      });
      if (enter) {
        await act(async () => {
          fireEvent.keyDown(element, { key: "Enter" });
        });
      }
    },
    async clear(element: Element) {
      await act(async () => {
        fireEvent.change(element, { target: { value: "" } });
      });
    },
    async selectOptions(element: Element, value: string) {
      await act(async () => {
        fireEvent.change(element, { target: { value } });
      });
    },
    async keyboard(keys: string) {
      const match = /^\{(.+)\}$/u.exec(keys);
      if (!match) throw new Error(`Unsupported keys: ${keys}`);
      await act(async () => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: match[1] });
      });
    },
  };
}
