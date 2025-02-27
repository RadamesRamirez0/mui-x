import * as React from 'react';
import useEnhancedEffect from '@mui/utils/useEnhancedEffect';
import useEventCallback from '@mui/utils/useEventCallback';
import useForkRef from '@mui/utils/useForkRef';
import { useValidation } from '../validation/useValidation';
import { useUtils } from '../useUtils';
import {
  FieldSection,
  UseFieldParams,
  UseFieldResponse,
  UseFieldForwardedProps,
  UseFieldInternalProps,
  AvailableAdjustKeyCode,
} from './useField.types';
import { adjustSectionValue, isAndroid, cleanString } from './useField.utils';
import { useFieldState } from './useFieldState';
import { useFieldCharacterEditing } from './useFieldCharacterEditing';

export const useField = <
  TValue,
  TDate,
  TSection extends FieldSection,
  TForwardedProps extends UseFieldForwardedProps,
  TInternalProps extends UseFieldInternalProps<any, any>,
>(
  params: UseFieldParams<TValue, TDate, TSection, TForwardedProps, TInternalProps>,
): UseFieldResponse<TForwardedProps> => {
  const utils = useUtils<TDate>();
  if (!utils.formatTokenMap) {
    throw new Error('This adapter is not compatible with the field components');
  }

  const {
    state,
    selectedSectionIndexes,
    setSelectedSections,
    clearValue,
    clearActiveSection,
    updateSectionValue,
    updateValueFromValueStr,
    setTempAndroidValueStr,
    sectionOrder,
    sectionsValueBoundaries,
  } = useFieldState(params);

  const { applyCharacterEditing, resetCharacterQuery } = useFieldCharacterEditing<TDate, TSection>({
    sections: state.sections,
    updateSectionValue,
    sectionsValueBoundaries,
    setTempAndroidValueStr,
  });

  const {
    inputRef: inputRefProp,
    internalProps,
    internalProps: { readOnly = false },
    forwardedProps: {
      onClick,
      onKeyDown,
      onFocus,
      onBlur,
      onMouseUp,
      onPaste,
      error,
      ...otherForwardedProps
    },
    fieldValueManager,
    valueManager,
    validator,
  } = params;

  const inputRef = React.useRef<HTMLInputElement>(null);
  const handleRef = useForkRef(inputRefProp, inputRef);
  const focusTimeoutRef = React.useRef<NodeJS.Timeout | undefined>(undefined);

  const syncSelectionFromDOM = () => {
    const browserStartIndex = inputRef.current!.selectionStart ?? 0;
    const nextSectionIndex =
      browserStartIndex <= state.sections[0].startInInput
        ? 1 // Special case if browser index is in invisible characters at the beginning.
        : state.sections.findIndex(
            (section) => section.startInInput - section.startSeparator.length > browserStartIndex,
          );
    const sectionIndex = nextSectionIndex === -1 ? state.sections.length - 1 : nextSectionIndex - 1;

    setSelectedSections(sectionIndex);
  };

  const handleInputClick = useEventCallback((...args) => {
    onClick?.(...(args as []));
    syncSelectionFromDOM();
  });

  const handleInputMouseUp = useEventCallback((event: React.MouseEvent) => {
    onMouseUp?.(event);

    // Without this, the browser will remove the selected when clicking inside an already-selected section.
    event.preventDefault();
  });

  const handleInputFocus = useEventCallback((...args) => {
    onFocus?.(...(args as []));
    // The ref is guaranteed to be resolved that this point.
    const input = inputRef.current;

    clearTimeout(focusTimeoutRef.current);
    focusTimeoutRef.current = setTimeout(() => {
      // The ref changed, the component got remounted, the focus event is no longer relevant.
      if (!input || input !== inputRef.current) {
        return;
      }

      if (selectedSectionIndexes != null) {
        return;
      }

      if (Number(input.selectionEnd) - Number(input.selectionStart) === input.value.length) {
        setSelectedSections('all');
      } else {
        syncSelectionFromDOM();
      }
    });
  });

  const handleInputBlur = useEventCallback((...args) => {
    onBlur?.(...(args as []));
    setSelectedSections(null);
  });

  const handleInputPaste = useEventCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
    onPaste?.(event);

    if (readOnly) {
      event.preventDefault();
      return;
    }

    const pastedValue = event.clipboardData.getData('text');
    if (
      selectedSectionIndexes &&
      selectedSectionIndexes.startIndex === selectedSectionIndexes.endIndex
    ) {
      const activeSection = state.sections[selectedSectionIndexes.startIndex];

      const lettersOnly = /^[a-zA-Z]+$/.test(pastedValue);
      const digitsOnly = /^[0-9]+$/.test(pastedValue);
      const isValidPastedValue =
        (activeSection.contentType === 'letter' && lettersOnly) ||
        (activeSection.contentType === 'digit' && digitsOnly);
      if (isValidPastedValue) {
        // Early return to let the paste update section, value
        return;
      }
      if (lettersOnly || digitsOnly) {
        // The pasted value correspond to a single section but not the expected type
        // skip the modification
        event.preventDefault();
        return;
      }
    }

    event.preventDefault();
    updateValueFromValueStr(pastedValue);
  });

  const handleInputChange = useEventCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly) {
      return;
    }

    const valueStr = event.target.value;
    const cleanValueStr = cleanString(valueStr);

    // If no section is selected, we just try to parse the new value
    // This line is mostly triggered by imperative code / application tests.
    if (selectedSectionIndexes == null) {
      updateValueFromValueStr(cleanValueStr);
      return;
    }

    const prevValueStr = cleanString(fieldValueManager.getValueStrFromSections(state.sections));

    let startOfDiffIndex = -1;
    let endOfDiffIndex = -1;
    for (let i = 0; i < prevValueStr.length; i += 1) {
      if (startOfDiffIndex === -1 && prevValueStr[i] !== cleanValueStr[i]) {
        startOfDiffIndex = i;
      }

      if (
        endOfDiffIndex === -1 &&
        prevValueStr[prevValueStr.length - i - 1] !== cleanValueStr[cleanValueStr.length - i - 1]
      ) {
        endOfDiffIndex = i;
      }
    }

    const activeSection = state.sections[selectedSectionIndexes.startIndex];

    const hasDiffOutsideOfActiveSection =
      startOfDiffIndex < activeSection.start ||
      prevValueStr.length - endOfDiffIndex - 1 > activeSection.end;

    if (hasDiffOutsideOfActiveSection) {
      // TODO: Support if the new date is valid
      return;
    }

    // The active section being selected, the browser has replaced its value with the key pressed by the user.
    const activeSectionEndRelativeToNewValue =
      cleanValueStr.length -
      prevValueStr.length +
      activeSection.end -
      cleanString(activeSection.endSeparator || '').length;
    const keyPressed = cleanValueStr.slice(activeSection.start, activeSectionEndRelativeToNewValue);

    if (isAndroid() && keyPressed.length === 0) {
      setTempAndroidValueStr(valueStr);
      return;
    }

    applyCharacterEditing({ keyPressed, sectionIndex: selectedSectionIndexes.startIndex });
  });

  const handleInputKeyDown = useEventCallback((event: React.KeyboardEvent) => {
    onKeyDown?.(event);

    // eslint-disable-next-line default-case
    switch (true) {
      // Select all
      case event.key === 'a' && (event.ctrlKey || event.metaKey): {
        // prevent default to make sure that the next line "select all" while updating
        // the internal state at the same time.
        event.preventDefault();
        setSelectedSections('all');
        break;
      }

      // Move selection to next section
      case event.key === 'ArrowRight': {
        event.preventDefault();

        if (selectedSectionIndexes == null) {
          setSelectedSections(sectionOrder.startIndex);
        } else if (selectedSectionIndexes.startIndex !== selectedSectionIndexes.endIndex) {
          setSelectedSections(selectedSectionIndexes.endIndex);
        } else {
          const nextSectionIndex =
            sectionOrder.neighbors[selectedSectionIndexes.startIndex].rightIndex;
          if (nextSectionIndex !== null) {
            setSelectedSections(nextSectionIndex);
          }
        }
        break;
      }

      // Move selection to previous section
      case event.key === 'ArrowLeft': {
        event.preventDefault();

        if (selectedSectionIndexes == null) {
          setSelectedSections(sectionOrder.endIndex);
        } else if (selectedSectionIndexes.startIndex !== selectedSectionIndexes.endIndex) {
          setSelectedSections(selectedSectionIndexes.startIndex);
        } else {
          const nextSectionIndex =
            sectionOrder.neighbors[selectedSectionIndexes.startIndex].leftIndex;
          if (nextSectionIndex !== null) {
            setSelectedSections(nextSectionIndex);
          }
        }
        break;
      }

      // Reset the value of the selected section
      case ['Backspace', 'Delete'].includes(event.key): {
        event.preventDefault();

        if (readOnly) {
          break;
        }

        if (
          selectedSectionIndexes == null ||
          (selectedSectionIndexes.startIndex === 0 &&
            selectedSectionIndexes.endIndex === state.sections.length - 1)
        ) {
          clearValue();
        } else {
          clearActiveSection();
        }
        resetCharacterQuery();
        break;
      }

      // Increment / decrement the selected section value
      case ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key): {
        event.preventDefault();

        if (readOnly || selectedSectionIndexes == null) {
          break;
        }

        const activeSection = state.sections[selectedSectionIndexes.startIndex];
        const activeDateManager = fieldValueManager.getActiveDateManager(
          utils,
          state,
          activeSection,
        );

        const newSectionValue = adjustSectionValue(
          utils,
          activeSection,
          event.key as AvailableAdjustKeyCode,
          sectionsValueBoundaries,
          activeDateManager.activeDate,
        );

        updateSectionValue({
          activeSection,
          newSectionValue,
          shouldGoToNextSection: false,
        });
        break;
      }
    }
  });

  useEnhancedEffect(() => {
    if (selectedSectionIndexes == null) {
      return;
    }

    const firstSelectedSection = state.sections[selectedSectionIndexes.startIndex];
    const lastSelectedSection = state.sections[selectedSectionIndexes.endIndex];
    let selectionStart = firstSelectedSection.startInInput;
    let selectionEnd = lastSelectedSection.endInInput;

    if (selectedSectionIndexes.shouldSelectBoundarySelectors) {
      selectionStart -= firstSelectedSection.startSeparator.length;
      selectionEnd += lastSelectedSection.endSeparator.length;
    }

    if (
      selectionStart !== inputRef.current!.selectionStart ||
      selectionEnd !== inputRef.current!.selectionEnd
    ) {
      inputRef.current!.setSelectionRange(selectionStart, selectionEnd);
    }
  });

  const validationError = useValidation(
    { ...internalProps, value: state.value },
    validator,
    valueManager.isSameError,
    valueManager.defaultErrorState,
  );

  const inputError = React.useMemo(() => {
    // only override when `error` is undefined.
    // in case of multi input fields, the `error` value is provided externally and will always be defined.
    if (error !== undefined) {
      return error;
    }

    return fieldValueManager.hasError(validationError);
  }, [fieldValueManager, validationError, error]);

  React.useEffect(() => {
    // Select the right section when focused on mount (`autoFocus = true` on the input)
    if (inputRef.current && inputRef.current === document.activeElement) {
      setSelectedSections('all');
    }

    return () => window.clearTimeout(focusTimeoutRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // If `state.tempValueStrAndroid` is still defined when running `useEffect`,
  // Then `onChange` has only been called once, which means the user pressed `Backspace` to reset the section.
  // This causes a small flickering on Android,
  // But we can't use `useEnhancedEffect` which is always called before the second `onChange` call and then would cause false positives.
  React.useEffect(() => {
    if (state.tempValueStrAndroid != null && selectedSectionIndexes != null) {
      resetCharacterQuery();
      clearActiveSection();
    }
  }, [state.tempValueStrAndroid]); // eslint-disable-line react-hooks/exhaustive-deps

  const valueStr = React.useMemo(
    () => state.tempValueStrAndroid ?? fieldValueManager.getValueStrFromSections(state.sections),
    [state.sections, fieldValueManager, state.tempValueStrAndroid],
  );

  const inputMode = React.useMemo(() => {
    if (selectedSectionIndexes == null) {
      return 'text';
    }

    if (state.sections[selectedSectionIndexes.startIndex].contentType === 'letter') {
      return 'text';
    }

    return 'tel';
  }, [selectedSectionIndexes, state.sections]);

  return {
    ...otherForwardedProps,
    value: valueStr,
    inputMode,
    readOnly,
    onClick: handleInputClick,
    onFocus: handleInputFocus,
    onBlur: handleInputBlur,
    onPaste: handleInputPaste,
    onChange: handleInputChange,
    onKeyDown: handleInputKeyDown,
    onMouseUp: handleInputMouseUp,
    error: inputError,
    ref: handleRef,
  };
};
