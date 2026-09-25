#!/bin/sh

_gods_eye_quote_arg() {
    _gods_eye_quoted_value=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
    printf "'%s'" "$_gods_eye_quoted_value"
}

_gods_eye_append_rewritten_arg() {
    _gods_eye_encoded_arg=$(_gods_eye_quote_arg "$1")
    if [ -n "$GODS_EYE_REWRITTEN_ARGS" ]; then
        GODS_EYE_REWRITTEN_ARGS="$GODS_EYE_REWRITTEN_ARGS $_gods_eye_encoded_arg"
    else
        GODS_EYE_REWRITTEN_ARGS=$_gods_eye_encoded_arg
    fi
}

_gods_eye_append_import_mount() {
    _gods_eye_encoded_volume=$(_gods_eye_quote_arg -v)
    _gods_eye_encoded_mount=$(_gods_eye_quote_arg "$1")
    if [ -n "$GODS_EYE_IMPORT_VOLUME_ARGS" ]; then
        GODS_EYE_IMPORT_VOLUME_ARGS="$GODS_EYE_IMPORT_VOLUME_ARGS $_gods_eye_encoded_volume $_gods_eye_encoded_mount"
    else
        GODS_EYE_IMPORT_VOLUME_ARGS="$_gods_eye_encoded_volume $_gods_eye_encoded_mount"
    fi
}

_gods_eye_resolve_import_path() {
    _gods_eye_input_path=$1
    _gods_eye_project_root=$2
    GODS_EYE_IMPORT_MOUNT=
    if [ ! -f "$_gods_eye_input_path" ]; then
        printf 'Import file does not exist or is not a regular file: %s\n' "$_gods_eye_input_path" >&2
        return 2
    fi

    case "$_gods_eye_input_path" in
        /*) _gods_eye_absolute_path=$_gods_eye_input_path ;;
        *) _gods_eye_absolute_path="$(pwd -P)/$_gods_eye_input_path" ;;
    esac
    if command -v readlink >/dev/null 2>&1; then
        _gods_eye_resolved_path=$(readlink -f "$_gods_eye_absolute_path" 2>/dev/null || true)
    else
        _gods_eye_resolved_path=
    fi
    if [ -z "$_gods_eye_resolved_path" ]; then
        _gods_eye_parent=$(CDPATH= cd -P "$(dirname "$_gods_eye_absolute_path")" && pwd -P) || {
            printf 'Could not resolve import file: %s\n' "$_gods_eye_input_path" >&2
            return 2
        }
        _gods_eye_resolved_path="$_gods_eye_parent/$(basename "$_gods_eye_absolute_path")"
    fi

    case "$_gods_eye_resolved_path" in
        "$_gods_eye_project_root"/*)
            _gods_eye_relative_path=${_gods_eye_resolved_path#"$_gods_eye_project_root"/}
            GODS_EYE_REWRITTEN_PATH="/workspace/$_gods_eye_relative_path"
            ;;
        *)
            _gods_eye_import_parent=$(CDPATH= cd -P "$(dirname "$_gods_eye_resolved_path")" && pwd -P) || {
                printf 'Could not resolve import file: %s\n' "$_gods_eye_input_path" >&2
                return 2
            }
            _gods_eye_import_base=$(basename "$_gods_eye_resolved_path")
            GODS_EYE_IMPORT_COUNT=$((GODS_EYE_IMPORT_COUNT + 1))
            GODS_EYE_IMPORT_MOUNT="$_gods_eye_import_parent:/import/$GODS_EYE_IMPORT_COUNT:ro"
            GODS_EYE_REWRITTEN_PATH="/import/$GODS_EYE_IMPORT_COUNT/$_gods_eye_import_base"
            ;;
    esac
}

gods_eye_rewrite_import_args() {
    if [ "$#" -eq 0 ]; then
        printf '%s\n' 'Launcher argument rewrite requires the checkout root.' >&2
        return 2
    fi
    _gods_eye_project_root=$(CDPATH= cd -P "$1" && pwd -P) || {
        printf '%s\n' 'Could not resolve the checkout root for imported files.' >&2
        return 2
    }
    shift
    GODS_EYE_REWRITTEN_ARGS=
    GODS_EYE_IMPORT_VOLUME_ARGS=
    GODS_EYE_IMPORT_COUNT=0

    if [ "${1-}" != prepare ]; then
        for _gods_eye_arg do
            _gods_eye_append_rewritten_arg "$_gods_eye_arg"
        done
        return 0
    fi

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --checkpoint|--reference-metrics)
                _gods_eye_option=$1
                shift
                _gods_eye_append_rewritten_arg "$_gods_eye_option"
                if [ "$#" -eq 0 ]; then
                    break
                fi
                _gods_eye_input=$1
                shift
                if ! _gods_eye_resolve_import_path "$_gods_eye_input" "$_gods_eye_project_root"; then
                    return 2
                fi
                if [ -n "$GODS_EYE_IMPORT_MOUNT" ]; then
                    _gods_eye_append_import_mount "$GODS_EYE_IMPORT_MOUNT"
                fi
                _gods_eye_append_rewritten_arg "$GODS_EYE_REWRITTEN_PATH"
                ;;
            --checkpoint=*|--reference-metrics=*)
                _gods_eye_option=${1%%=*}
                _gods_eye_input=${1#*=}
                shift
                if ! _gods_eye_resolve_import_path "$_gods_eye_input" "$_gods_eye_project_root"; then
                    return 2
                fi
                if [ -n "$GODS_EYE_IMPORT_MOUNT" ]; then
                    _gods_eye_append_import_mount "$GODS_EYE_IMPORT_MOUNT"
                fi
                _gods_eye_append_rewritten_arg "$_gods_eye_option=$GODS_EYE_REWRITTEN_PATH"
                ;;
            *)
                _gods_eye_append_rewritten_arg "$1"
                shift
                ;;
        esac
    done
    return 0
}
