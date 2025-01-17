"use strict";

const repository = require('../../services/repository');
const SearchContext = require('../../services/search/search_context.js');
const log = require('../../services/log');
const scriptService = require('../../services/script');
const searchService = require('../../services/search/services/search');
const noteRevisionService = require("../../services/note_revisions.js");

async function search(note) {
    let searchResultNoteIds;

    const searchScript = note.getRelationValue('searchScript');
    const searchString = note.getLabelValue('searchString');

    if (searchScript) {
        searchResultNoteIds = await searchFromRelation(note, 'searchScript');
    } else {
        const searchContext = new SearchContext({
            fastSearch: note.hasLabel('fastSearch'),
            ancestorNoteId: note.getRelationValue('ancestor'),
            ancestorDepth: note.getLabelValue('ancestorDepth'),
            includeArchivedNotes: note.hasLabel('includeArchivedNotes'),
            orderBy: note.getLabelValue('orderBy'),
            orderDirection: note.getLabelValue('orderDirection'),
            limit: note.getLabelValue('limit'),
            debug: note.hasLabel('debug'),
            fuzzyAttributeSearch: false
        });

        searchResultNoteIds = searchService.findNotesWithQuery(searchString, searchContext)
            .map(sr => sr.noteId);
    }

    // we won't return search note's own noteId
    // also don't allow root since that would force infinite cycle
    return searchResultNoteIds.filter(resultNoteId => !['root', note.noteId].includes(resultNoteId));
}

async function searchFromNote(req) {
    const note = repository.getNote(req.params.noteId);

    if (!note) {
        return [404, `Note ${req.params.noteId} has not been found.`];
    }

    if (note.isDeleted) {
        // this can be triggered from recent changes and it's harmless to return empty list rather than fail
        return [];
    }

    if (note.type !== 'search') {
        return [400, `Note ${req.params.noteId} is not a search note.`]
    }

    return await search(note);
}

const ACTION_HANDLERS = {
    deleteNote: (action, note) => {
        note.isDeleted = true;
        note.save();
    },
    deleteNoteRevisions: (action, note) => {
        noteRevisionService.eraseNoteRevisions(note.getRevisions().map(rev => rev.noteRevisionId));
    },
    deleteLabel: (action, note) => {
        for (const label of note.getOwnedLabels(action.labelName)) {
            label.isDeleted = true;
            label.save();
        }
    },
    deleteRelation: (action, note) => {
        for (const relation of note.getOwnedRelations(action.relationName)) {
            relation.isDeleted = true;
            relation.save();
        }
    },
    renameLabel: (action, note) => {
        for (const label of note.getOwnedLabels(action.oldLabelName)) {
            label.name = action.newLabelName;
            label.save();
        }
    },
    renameRelation: (action, note) => {
        for (const relation of note.getOwnedRelations(action.oldRelationName)) {
            relation.name = action.newRelationName;
            relation.save();
        }
    },
    setLabelValue: (action, note) => {
        note.setLabel(action.labelName, action.labelValue);
    },
    setRelationTarget: (action, note) => {
        note.setRelation(action.relationName, action.targetNoteId);
    },
    executeScript: (action, note) => {
        if (!action.script || !action.script.trim()) {
            log.info("Ignoring executeScript since the script is empty.")
            return;
        }

        const scriptFunc = new Function("note", action.script);
        scriptFunc(note);

        note.save();
    }
};

function getActions(note) {
    return note.getLabels('action')
        .map(actionLabel => {
            let action;

            try {
                action = JSON.parse(actionLabel.value);
            } catch (e) {
                log.error(`Cannot parse '${actionLabel.value}' into search action, skipping.`);
                return null;
            }

            if (!(action.name in ACTION_HANDLERS)) {
                log.error(`Cannot find '${action.name}' search action handler, skipping.`);
                return null;
            }

            return action;
        })
        .filter(a => !!a);
}

async function searchAndExecute(req) {
    const note = repository.getNote(req.params.noteId);

    if (!note) {
        return [404, `Note ${req.params.noteId} has not been found.`];
    }

    if (note.isDeleted) {
        // this can be triggered from recent changes and it's harmless to return empty list rather than fail
        return [];
    }

    if (note.type !== 'search') {
        return [400, `Note ${req.params.noteId} is not a search note.`]
    }

    const searchResultNoteIds = await search(note);

    const actions = getActions(note);

    for (const resultNoteId of searchResultNoteIds) {
        const resultNote = repository.getNote(resultNoteId);

        if (!resultNote || resultNote.isDeleted) {
            continue;
        }

        for (const action of actions) {
            try {
                log.info(`Applying action handler to note ${resultNote.noteId}: ${JSON.stringify(action)}`);

                ACTION_HANDLERS[action.name](action, resultNote);
            }
            catch (e) {
                log.error(`ExecuteScript search action failed with ${e.message}`);
            }
        }
    }
}

async function searchFromRelation(note, relationName) {
    const scriptNote = note.getRelationTarget(relationName);

    if (!scriptNote) {
        log.info(`Search note's relation ${relationName} has not been found.`);

        return [];
    }

    if (!scriptNote.isJavaScript() || scriptNote.getScriptEnv() !== 'backend') {
        log.info(`Note ${scriptNote.noteId} is not executable.`);

        return [];
    }

    if (!note.isContentAvailable) {
        log.info(`Note ${scriptNote.noteId} is not available outside of protected session.`);

        return [];
    }

    const result = await scriptService.executeNote(scriptNote, { originEntity: note });

    if (!Array.isArray(result)) {
        log.info(`Result from ${scriptNote.noteId} is not an array.`);

        return [];
    }

    if (result.length === 0) {
        return [];
    }

    // we expect either array of noteIds (strings) or notes, in that case we extract noteIds ourselves
    return typeof result[0] === 'string' ? result : result.map(item => item.noteId);
}

function quickSearch(req) {
    const {searchString} = req.params;

    const searchContext = new SearchContext({
        fastSearch: false,
        includeArchivedNotes: false,
        fuzzyAttributeSearch: false
    });

    return searchService.findNotesWithQuery(searchString, searchContext)
        .map(sr => sr.noteId);
}

function search(req) {
    const {searchString} = req.params;

    const searchContext = new SearchContext({
        fastSearch: false,
        includeArchivedNotes: true,
        fuzzyAttributeSearch: false
    });

    return searchService.findNotesWithQuery(searchString, searchContext)
        .map(sr => sr.noteId);
}

function getRelatedNotes(req) {
    const attr = req.body;

    const searchSettings = {
        fastSearch: true,
        includeArchivedNotes: false,
        fuzzyAttributeSearch: false
    };

    const matchingNameAndValue = searchService.findNotesWithQuery(formatAttrForSearch(attr, true), new SearchContext(searchSettings));
    const matchingName = searchService.findNotesWithQuery(formatAttrForSearch(attr, false), new SearchContext(searchSettings));

    const results = [];

    const allResults = matchingNameAndValue.concat(matchingName);

    for (const record of allResults) {
        if (results.length >= 20) {
            break;
        }

        if (results.find(res => res.noteId === record.noteId)) {
            continue;
        }

        results.push(record);
    }

    return {
        count: allResults.length,
        results
    };
}

function formatAttrForSearch(attr, searchWithValue) {
    let searchStr = '';

    if (attr.type === 'label') {
        searchStr += '#';
    }
    else if (attr.type === 'relation') {
        searchStr += '~';
    }
    else {
        throw new Error(`Unrecognized attribute type ${JSON.stringify(attr)}`);
    }

    searchStr += attr.name;

    if (searchWithValue && attr.value) {
        if (attr.type === 'relation') {
            searchStr += ".noteId";
        }

        searchStr += '=';
        searchStr += formatValue(attr.value);
    }

    return searchStr;
}

function formatValue(val) {
    if (!/[^\w_-]/.test(val)) {
        return val;
    }
    else if (!val.includes('"')) {
        return '"' + val + '"';
    }
    else if (!val.includes("'")) {
        return "'" + val + "'";
    }
    else if (!val.includes("`")) {
        return "`" + val + "`";
    }
    else {
        return '"' + val.replace(/"/g, '\\"') + '"';
    }
}

module.exports = {
    searchFromNote,
    searchAndExecute,
    getRelatedNotes,
    quickSearch,
    search
};
