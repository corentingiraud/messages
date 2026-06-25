import {
    BasicTextStyleButton,
    blockTypeSelectItems,
    BlockTypeSelect,
    ColorStyleButton,
    CreateLinkButton,
    ExperimentalMobileFormattingToolbarController,
    FileCaptionButton,
    FileDeleteButton,
    FilePreviewButton,
    FileReplaceButton,
    FormattingToolbar,
    TextAlignButton,
    useBlockNoteEditor,
} from "@blocknote/react";
import { useEffect, useMemo, useState } from "react";

import { isNativePlatform } from "@/features/native/platform";
import { ColumnLayoutInsertButton } from "./column-layout-block/column-layout-insert-button";
import { ImageUploadButton } from "./image-upload-button";
import { isHiddenBlockTypeSelectItem } from "./utils";

const ToolbarSeparator = () => (
    <div className="bn-toolbar-separator" role="separator" />
);

type ToolbarProps = {
    children?: React.ReactNode;
}
export const Toolbar = ({ children }: ToolbarProps) => {
    const editor = useBlockNoteEditor();
    const filteredItems = useMemo(
        () => blockTypeSelectItems(editor.dictionary).filter(
            (item) => !isHiddenBlockTypeSelectItem(item),
        ),
        [editor.dictionary],
    );

    // Track focus within this composer so the mobile keyboard toolbar shows
    // only while it's active. Focus is considered "kept" as long as it stays
    // inside the editor's container — which also holds the toolbar — so tapping
    // a toolbar button doesn't tear it down.
    const [isFocused, setIsFocused] = useState(false);
    useEffect(() => {
        if (!isNativePlatform()) return;
        const editorEl = editor._tiptapEditor.view.dom as HTMLElement;
        const container = editorEl.closest(".bn-container") ?? editorEl;
        const isWithinComposer = (node: EventTarget | null) => {
            if (!(node instanceof Node)) return false;
            if (container.contains(node)) return true;
            // The fixed toolbar and BlockNote's popovers (mantine dropdowns:
            // block-type, colors, link…) portal outside the editor container;
            // keep the toolbar alive while focus is in any of them.
            return (
                node instanceof Element &&
                !!node.closest('.bn-mobile-formatting-toolbar, [class*="mantine-"][class*="-dropdown"]')
            );
        };

        const onFocusIn = (event: FocusEvent) => {
            if (isWithinComposer(event.target)) setIsFocused(true);
        };
        const onFocusOut = (event: FocusEvent) => {
            // Hide only when focus leaves the composer entirely; moving between
            // the editor and the toolbar keeps it visible.
            if (!isWithinComposer(event.relatedTarget)) setIsFocused(false);
        };
        document.addEventListener("focusin", onFocusIn);
        document.addEventListener("focusout", onFocusOut);
        return () => {
            document.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("focusout", onFocusOut);
        };
    }, [editor]);

    const toolbarContent = (
        <FormattingToolbar>
            <BlockTypeSelect key={"blockTypeSelect"} items={filteredItems} />
            <ImageUploadButton />
            <ColumnLayoutInsertButton />

            <ToolbarSeparator key={"separator-1"} />

            <FileCaptionButton key={"fileCaptionButton"} />
            <FileReplaceButton key={"fileReplaceButton"} />
            <FileDeleteButton key={"fileDeleteButton"} />
            <FilePreviewButton key={"filePreviewButton"} />
            <BasicTextStyleButton
                basicTextStyle={"bold"}
                key={"boldStyleButton"}
            />
            <BasicTextStyleButton
                basicTextStyle={"italic"}
                key={"italicStyleButton"}
            />
            <BasicTextStyleButton
                basicTextStyle={"underline"}
                key={"underlineStyleButton"}
            />
            <BasicTextStyleButton
                basicTextStyle={"strike"}
                key={"strikeStyleButton"}
            />

            <ToolbarSeparator key={"separator-2"} />

            <ColorStyleButton key={"colorStyleButton"} />

            <ToolbarSeparator key={"separator-3"} />

            <TextAlignButton textAlignment={"left"} key={"textAlignLeftButton"} />
            <TextAlignButton textAlignment={"center"} key={"textAlignCenterButton"} />
            <TextAlignButton textAlignment={"right"} key={"textAlignRightButton"} />

            <ToolbarSeparator key={"separator-4"} />

            <CreateLinkButton key={"createLinkButton"} />
            {children}
        </FormattingToolbar>
    );

    // On the native app, pin the toolbar right above the on-screen keyboard
    // while the composer is focused. BlockNote's experimental controller owns
    // the keyboard-tracking (VirtualKeyboard / Visual Viewport) and exposes the
    // offset via the --bn-mobile-keyboard-offset CSS variable.
    if (isNativePlatform()) {
        if (!isFocused) return null;
        return (
            <ExperimentalMobileFormattingToolbarController
                formattingToolbar={() => toolbarContent}
            />
        );
    }

    return toolbarContent;
}
