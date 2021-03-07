import NoteDb from './NoteDb'
import {
  NoteDoc,
  FolderDoc,
  AllDocsMap,
  ObjectMap,
  Attachment,
  FolderDocEditibleProps,
  NoteDocEditibleProps,
  NoteDocImportableProps,
  TagDocEditibleProps,
  TagDoc,
  PopulatedFolderDoc,
} from './types'
import { join } from 'path'
import dashify from 'dashify'
import parsePath from 'path-parse'
import {
  isFolderPathnameValid,
  getParentFolderPathname,
  createUnprocessableEntityError,
  getNow,
  getFolderId,
  generateNoteId,
  excludeNoteIdPrefix,
  getTagId,
  isTagNameValid,
  values,
  isSubPathname,
  keys,
} from './utils'
import { escapeRegExp, generateId, getHexatrigesimalString } from '../string'
import {
  prepareDirectory,
  readFileAsString,
  readdir,
  readFileType,
  writeFile,
  unlinkFile,
} from '../electronOnly'

interface StorageJSONData {
  folderMap: ObjectMap<FolderDoc>
  tagMap: ObjectMap<TagDoc>
}

class FSNoteDb implements NoteDb {
  type = 'fs'
  id: string
  name: string
  location: string
  data: StorageJSONData | null = null

  constructor(id: string, name: string, location: string) {
    this.id = id
    this.name = name
    this.location = location
  }

  async init(): Promise<void> {
    await prepareDirectory(this.location)
    await prepareDirectory(this.getNotesFolderPathname())
    await prepareDirectory(this.getAttachmentsFolderPathname())
    await this.loadBoostNoteJSON()
    await this.upsertFolder('/')

    const notes = await this.loadAllNotes()
    const missingFolderPathnameSet = new Set<string>()
    const missingTagNameSet = new Set<string>()
    for (const note of notes) {
      if (note.trashed) {
        continue
      }
      missingFolderPathnameSet.add(note.folderPathname)
      note.tags.forEach((tag) => {
        if (this.data!.tagMap[tag] == null) {
          missingTagNameSet.add(tag)
        }
      })
    }

    await Promise.all([
      ...[...missingFolderPathnameSet].map((pathname) =>
        this.upsertFolder(pathname)
      ),
      ...[...missingTagNameSet].map((tagName) => this.upsertTag(tagName)),
    ])
  }

  async getFolder(pathname: string): Promise<FolderDoc | null> {
    const folderDoc = this.data!.folderMap[pathname]
    return folderDoc != null ? folderDoc : null
  }

  async getAllFolders() {
    return values(this.data!.folderMap)
  }

  async getFoldersByPathnames(pathnames: string[]) {
    const results = await Promise.all(
      pathnames.map((pathname) => this.getFolder(pathname))
    )

    return results.filter((result) => result != null) as FolderDoc[]
  }

  async upsertFolder(
    pathname: string,
    props?: Partial<FolderDocEditibleProps>
  ): Promise<FolderDoc> {
    if (!isFolderPathnameValid(pathname)) {
      throw createUnprocessableEntityError(
        `pathname is invalid, got \`${pathname}\``
      )
    }
    if (pathname !== '/') {
      await this.doesParentFolderExistOrCreate(pathname)
    }

    const folder = await this.getFolder(pathname)
    if (folder != null && props == null) {
      return folder
    }
    const now = getNow()
    const newFolderDoc = {
      ...(folder || {
        _id: getFolderId(pathname),
        createdAt: now,
        data: {},
      }),
      ...props,
      updatedAt: now,
    }

    this.data!.folderMap[pathname] = newFolderDoc
    await this.saveBoostNoteJSON()

    return newFolderDoc
  }

  async removeFolder(pathname: string) {
    const newFolderMap = { ...this.data!.folderMap }
    const foldersToDelete = this.getAllFolderUnderPathname(pathname)
    const foldersToDeleteSet = new Set(foldersToDelete)

    const allNotes = await this.loadAllNotes()

    await Promise.all(
      allNotes.map(async (note) => {
        if (foldersToDeleteSet.has(note.folderPathname)) {
          await this.trashNote(note._id)
        }
      })
    )

    foldersToDelete.forEach((folderPathname) => {
      delete newFolderMap[folderPathname]
    })
    this.data!.folderMap = newFolderMap
    await this.saveBoostNoteJSON()
  }

  async doesParentFolderExistOrCreate(pathname: string) {
    const parentPathname = getParentFolderPathname(pathname)
    if (parentPathname !== '/') {
      await this.upsertFolder(parentPathname)
    }
  }

  async getNote(noteId: string): Promise<NoteDoc | null> {
    const notePathname = this.getNotePathname(noteId)
    const rawContent = await readFileAsString(notePathname)

    return JSON.parse(rawContent)
  }

  async getNotesByFolder(folderPathname: string) {
    folderPathname
  }

  async getAllDocsMap(): Promise<AllDocsMap> {
    const notes = await this.loadAllNotes()
    const noteMap = notes.reduce((map, note) => {
      map[note._id] = note
      return map
    }, {})

    return {
      noteMap,
      folderMap: this.data!.folderMap,
      tagMap: this.data!.tagMap,
    }
  }

  async getAttachmentMap(): Promise<ObjectMap<Attachment>> {
    await prepareDirectory(this.getAttachmentsFolderPathname())
    const fileDirents = await readdir(this.getAttachmentsFolderPathname(), {
      withFileTypes: true,
    })
    const fileNames = fileDirents.reduce<string[]>((fileNames, dirent) => {
      if (!dirent.isDirectory()) {
        fileNames.push(dirent.name)
      }
      return fileNames
    }, [])

    const attachmentMap: ObjectMap<Attachment> = {}
    for (const fileName of fileNames) {
      const filePathname = this.getAttachmentPathname(fileName)
      const mime = await readFileType(filePathname)
      if (!mime.startsWith('image/')) {
        continue
      }

      attachmentMap[fileName] = {
        name: fileName,
        type: mime,
        getData: async () => {
          return {
            type: 'src',
            src: this.appendFileProtocol(filePathname),
          }
        },
      }
    }

    return attachmentMap
  }

  async upsertAttachments(files: File[]): Promise<Attachment[]> {
    const attachments: Attachment[] = []
    let time = Date.now()
    for (const file of files) {
      const { name, ext } = parsePath(file.name)
      const fileName = `${dashify(name)}-${getHexatrigesimalString(
        time++
      )}${ext}`
      const data = Buffer.from(await file.arrayBuffer())
      const attachmentPathname = this.getAttachmentPathname(fileName)
      await writeFile(attachmentPathname, data)

      attachments.push({
        name: fileName,
        type: file.type,
        getData: async () => {
          return {
            type: 'src',
            src: this.appendFileProtocol(attachmentPathname),
          }
        },
      })
    }
    return attachments
  }

  async removeAttachment(fileName: string): Promise<void> {
    const attachmentPathname = this.getAttachmentPathname(fileName)
    await unlinkFile(attachmentPathname)
  }

  async createNote(
    noteProps: Partial<NoteDocEditibleProps | NoteDocImportableProps>
  ) {
    const now = getNow()
    const noteDoc: NoteDoc = {
      _id: generateNoteId(),
      title: '',
      content: '',
      tags: [],
      folderPathname: '/',
      data: {},
      createdAt: now,
      updatedAt: now,
      ...noteProps,
      trashed: false,
      _rev: generateId(),
    }

    await this.upsertFolder(noteDoc.folderPathname)
    await Promise.all(noteDoc.tags.map((tagName) => this.upsertTag(tagName)))

    await writeFile(
      this.getNotePathname(excludeNoteIdPrefix(noteDoc._id)),
      JSON.stringify(noteDoc)
    )

    return noteDoc
  }

  async updateNote(noteId: string, noteProps: Partial<NoteDocEditibleProps>) {
    const notePathname = this.getNotePathname(noteId)
    const rawNoteDoc = await readFileAsString(notePathname)
    const noteDoc: NoteDoc = JSON.parse(rawNoteDoc)
    // TODO: If note doesn't exist, throw not found error

    if (noteProps.folderPathname) {
      await this.upsertFolder(noteProps.folderPathname)
    }
    if (noteProps.tags) {
      await Promise.all(
        noteProps.tags.map((tagName) => this.upsertTag(tagName))
      )
    }

    const now = getNow()
    const newNoteDoc = {
      ...noteDoc,
      ...noteProps,
      updatedAt: now,
      _rev: generateId(),
    }

    await writeFile(notePathname, JSON.stringify(newNoteDoc))

    return newNoteDoc
  }

  async trashNote(noteId: string): Promise<NoteDoc> {
    const notePathname = this.getNotePathname(noteId)
    const rawNoteDoc = await readFileAsString(notePathname)
    const noteDoc: NoteDoc = JSON.parse(rawNoteDoc)
    // TODO: If note doesn't exist, throw not found error
    if (noteDoc.trashed) {
      return noteDoc
    }

    const newNoteDoc = {
      ...noteDoc,
      trashed: true,
    }

    await writeFile(notePathname, JSON.stringify(newNoteDoc))

    return newNoteDoc
  }

  async untrashNote(noteId: string): Promise<NoteDoc> {
    const notePathname = this.getNotePathname(noteId)
    const rawNoteDoc = await readFileAsString(notePathname)
    const noteDoc: NoteDoc = JSON.parse(rawNoteDoc)
    // TODO: If note doesn't exist, throw not found error
    if (!noteDoc.trashed) {
      return noteDoc
    }

    await this.upsertFolder(noteDoc.folderPathname)

    await Promise.all(
      noteDoc.tags.map((tag) => {
        this.upsertTag(tag)
      })
    )

    const newNoteDoc = {
      ...noteDoc,
      trashed: false,
    }

    await writeFile(notePathname, JSON.stringify(newNoteDoc))

    return newNoteDoc
  }

  async bookmarkNote(noteId: string): Promise<NoteDoc> {
    const notePathname = this.getNotePathname(noteId)
    const rawNoteDoc = await readFileAsString(notePathname)
    const noteDoc: NoteDoc = JSON.parse(rawNoteDoc)
    if (noteDoc.data.bookmarked) {
      return noteDoc
    }

    const newNoteDoc = {
      ...noteDoc,
      data: {
        ...noteDoc.data,
        bookmarked: true,
      },
    }

    await writeFile(notePathname, JSON.stringify(newNoteDoc))

    return newNoteDoc
  }

  async unbookmarkNote(noteId: string): Promise<NoteDoc> {
    const notePathname = this.getNotePathname(noteId)
    const rawNoteDoc = await readFileAsString(notePathname)
    const noteDoc: NoteDoc = JSON.parse(rawNoteDoc)
    if (!noteDoc.data.bookmarked) {
      return noteDoc
    }

    const newNoteDoc = {
      ...noteDoc,
      data: {
        ...noteDoc.data,
        bookmarked: false,
      },
    }

    await writeFile(notePathname, JSON.stringify(newNoteDoc))

    return newNoteDoc
  }

  async purgeNote(noteId: string): Promise<void> {
    // TODO: Check file does exist or throw error
    const notePathname = this.getNotePathname(noteId)
    await unlinkFile(notePathname)
  }

  async getTag(tagName: string): Promise<TagDoc | null> {
    const tagDoc = this.data!.tagMap[tagName]
    return tagDoc != null ? tagDoc : null
  }

  async upsertTag(tagName: string, props?: Partial<TagDocEditibleProps>) {
    if (!isTagNameValid(tagName)) {
      throw createUnprocessableEntityError(
        `tag name is invalid, got \`${tagName}\``
      )
    }

    const tag = await this.getTag(tagName)
    if (tag != null && props == null) {
      return tag
    }

    const now = getNow()
    const tagDoc = {
      ...(tag || {
        _id: getTagId(tagName),
        createdAt: now,
        data: {},
      }),
      ...props,
      updatedAt: now,
    }

    this.data!.tagMap[tagName] = tagDoc

    await this.saveBoostNoteJSON()

    return tagDoc
  }

  async updateTagByName(
    tagName: string,
    props?: Partial<TagDocEditibleProps>
  ): Promise<void> {
    await this.upsertTag(tagName, props)
    await this.saveBoostNoteJSON()
  }

  async removeTag(tagName: string): Promise<void> {
    const notes = await this.loadAllNotes()
    const notesWithTags = notes.filter((note) => {
      return note.tags.indexOf(tagName) > -1
    })
    for (const note of notesWithTags) {
      await this.updateNote(note._id, {
        ...note,
        tags: note.tags.filter((tag) => tag !== tagName),
      })
    }

    delete this.data?.tagMap[tagName]

    await this.saveBoostNoteJSON()
  }

  async renameTag(currentTagName: string, newTagName: string): Promise<void> {
    const notes = await this.loadAllNotes()
    const notesWithTags = notes.filter((note) => {
      return note.tags.indexOf(currentTagName) > -1
    })
    for (const note of notesWithTags) {
      await this.updateNote(note._id, {
        ...note,
        tags: note.tags.flatMap((tag) =>
          tag === currentTagName ? [newTagName] : [tag]
        ),
      })
    }

    this.data!.tagMap[newTagName] = this.data?.tagMap[currentTagName]
    delete this.data?.tagMap[currentTagName]

    await this.saveBoostNoteJSON()
  }

  async renameFolder(pathname: string, newPathname: string) {
    if (!isFolderPathnameValid(pathname)) {
      throw createUnprocessableEntityError(
        `pathname is invalid, got \`${pathname}\``
      )
    }
    if (!isFolderPathnameValid(newPathname)) {
      throw createUnprocessableEntityError(
        `pathname is invalid, got \`${newPathname}\``
      )
    }
    const folder = await this.getFolder(pathname)
    if (folder == null) {
      throw createUnprocessableEntityError(
        `The folder does not exist, \`${pathname}\``
      )
    }
    if (isSubPathname(pathname, newPathname)) {
      throw createUnprocessableEntityError(
        `The destination folder is a sub folder of the target folder.`
      )
    }
    const newFolder = await this.getFolder(newPathname)
    if (newFolder != null) {
      throw createUnprocessableEntityError(
        `The destination folder already exist, \`${newPathname}\``
      )
    }

    const updatedFolderMap = new Map<string, PopulatedFolderDoc>()
    const updatedNotes: NoteDoc[] = []
    const allFoldersToRename = this.getAllFolderUnderPathname(pathname).sort()

    const replacePathname = (folderPathname: string) => {
      return folderPathname.replace(
        new RegExp(`^${escapeRegExp(pathname)}`, 'g'),
        newPathname
      )
    }
    await Promise.all(
      allFoldersToRename.map(async (folderPathname) => {
        const newFolderPathname = replacePathname(folderPathname)
        updatedFolderMap.set(newFolderPathname, {
          ...(await this.upsertFolder(newFolderPathname)),
          pathname: newFolderPathname,
          noteIdSet: new Set<string>(),
        })
      })
    )

    const allNotes = await this.loadAllNotes()
    for (const note of allNotes) {
      if (
        note.folderPathname !== pathname &&
        !note.folderPathname.startsWith(`${pathname}/`)
      ) {
        continue
      }

      const newFolderPathname = replacePathname(note.folderPathname)
      const updatedNote = {
        ...note,
        folderPathname: newFolderPathname,
      }

      updatedFolderMap.get(newFolderPathname)!.noteIdSet.add(updatedNote._id)
      updatedNotes.push(updatedNote)
    }

    const newFolderMap = allFoldersToRename.reduce(
      (map, pathname) => {
        if (map[pathname] != null) {
          delete map[pathname]
        }
        return map
      },
      { ...this.data!.folderMap }
    )
    updatedFolderMap.forEach((updatedFolderDoc) => {
      const { _id, createdAt, updatedAt, data } = updatedFolderDoc
      newFolderMap[updatedFolderDoc.pathname] = {
        _id,
        createdAt,
        updatedAt,
        data,
      }
    })

    await Promise.all(
      updatedNotes.map((note) => {
        return writeFile(this.getNotePathname(note._id), JSON.stringify(note))
      })
    )

    this.data!.folderMap = newFolderMap
    await this.saveBoostNoteJSON()

    const updatedFolders: PopulatedFolderDoc[] = [...updatedFolderMap.values()]

    return {
      notes: updatedNotes,
      folders: updatedFolders,
      removedFolders: allFoldersToRename,
    }
  }

  getAllFolderUnderPathname(pathname: string) {
    const allFolderPathnames = keys(this.data!.folderMap)
    const pathnameRegexp = new RegExp(`^${escapeRegExp(pathname)}/`, 'g')
    const subFolderPathnames = allFolderPathnames.filter((pathname) => {
      return pathnameRegexp.test(pathname)
    })

    return [pathname, ...subFolderPathnames]
  }

  getBoostNoteJSONPath() {
    return join(this.location, 'boostnote.json')
  }

  async loadBoostNoteJSON(): Promise<void> {
    const jsonPathname = this.getBoostNoteJSONPath()
    try {
      const rawContent = await readFileAsString(jsonPathname)
      this.data = JSON.parse(rawContent)
    } catch (error) {
      if (error.code === 'ENOENT') {
        const defaultBoostNoteJSON: StorageJSONData = {
          folderMap: {},
          tagMap: {},
        }
        this.data = defaultBoostNoteJSON
        writeFile(jsonPathname, JSON.stringify(defaultBoostNoteJSON))
      } else {
        throw error
      }
    }
  }

  async saveBoostNoteJSON(): Promise<void> {
    await writeFile(this.getBoostNoteJSONPath(), JSON.stringify(this.data))
  }

  async loadAllNotes(): Promise<NoteDoc[]> {
    const fileNames = await readdir(this.getNotesFolderPathname())

    const noteFileNames = fileNames.filter((fileName) =>
      /\.json$/.test(fileName)
    )
    const notes = []

    for (const noteFileName of noteFileNames) {
      try {
        const rawDoc = await readFileAsString(
          join(this.location, 'notes', noteFileName)
        )
        notes.push(JSON.parse(rawDoc) as NoteDoc)
      } catch (error) {
        console.error(error)
      }
    }

    return notes
  }

  getNotesFolderPathname() {
    return join(this.location, 'notes')
  }

  getNotePathname(noteId: string) {
    return join(
      this.getNotesFolderPathname(),
      `${excludeNoteIdPrefix(noteId)}.json`
    )
  }

  getAttachmentsFolderPathname() {
    return join(this.location, 'attachments')
  }

  getAttachmentPathname(fileName: string) {
    return join(this.getAttachmentsFolderPathname(), fileName)
  }

  appendFileProtocol(pathname: string) {
    return `file://${pathname.replace(/\\/g, '/')}`
  }
}

export default FSNoteDb
