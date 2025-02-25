import { Editor, Vec2d, createShapeId, getSvgAsImage, uniqueId } from '@tldraw/tldraw'
import { PreviewShape } from '../PreviewShape/PreviewShape'
import { getHtmlFromOpenAI } from './getHtmlFromOpenAI'
import { track } from '@vercel/analytics/react'
import { uploadLink } from './uploadLink'

export async function makeReal(editor: Editor, apiKey: string) {
	const newShapeId = createShapeId()
	const selectedShapes = editor.getSelectedShapes()

	if (selectedShapes.length === 0) {
		throw Error('First select something to make real.')
	}

	const { maxX, midY } = editor.getSelectionPageBounds()

	const previousPreviews = selectedShapes.filter((shape) => {
		return shape.type === 'preview'
	}) as PreviewShape[]

	const svg = await editor.getSvg(selectedShapes, {
		scale: 1,
		background: true,
	})

	if (!svg) throw Error(`Could not get the SVG.`)

	const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)

	const blob = await getSvgAsImage(svg, IS_SAFARI, {
		type: 'png',
		quality: 0.8,
		scale: 1,
	})

	const dataUrl = await blobToBase64(blob!)

	//// For testing, let's see the image
	// downloadDataURLAsFile(dataUrl, 'tldraw.png')

	editor.createShape<PreviewShape>({
		id: newShapeId,
		type: 'preview',
		x: maxX + 60, // to the right of the selection
		y: midY - (540 * 2) / 3 / 2, // half the height of the preview's initial shape
		props: { html: '', source: dataUrl as string },
	})

	if (previousPreviews.length > 0) {
		track('repeat_make_real', { timestamp: Date.now() })
	}

	const textFromShapes = getSelectionAsText(editor)

	try {
		const json = await getHtmlFromOpenAI({
			image: dataUrl,
			apiKey,
			text: textFromShapes,
			previousPreviews,
			theme: editor.user.getUserPreferences().isDarkMode ? 'dark' : 'light',
		})

		if (json.error) {
			throw Error(`${json.error.message?.slice(0, 100)}...`)
		}

		console.log(`Response: ${json.choices[0].message.content}`)

		const message = json.choices[0].message.content
		const start = message.indexOf('<!DOCTYPE html>')
		const end = message.indexOf('</html>')
		const html = message.slice(start, end + '</html>'.length)

		if (html.length < 100) {
			console.warn(message)
			throw Error('Could not generate a design from those wireframes.')
		}

		await uploadLink(newShapeId, html)

		editor.updateShape<PreviewShape>({
			id: newShapeId,
			type: 'preview',
			props: {
				html,
				source: dataUrl as string,
				linkUploadVersion: 1,
				uploadedShapeId: newShapeId,
			},
		})
	} catch (e) {
		editor.deleteShape(newShapeId)
		throw e
	}
}

export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, _) => {
		const reader = new FileReader()
		reader.onloadend = () => resolve(reader.result as string)
		reader.readAsDataURL(blob)
	})
}

function getSelectionAsText(editor: Editor) {
	const selectedShapeIds = editor.getSelectedShapeIds()
	const selectedShapeDescendantIds = editor.getShapeAndDescendantIds(selectedShapeIds)

	const texts = Array.from(selectedShapeDescendantIds)
		.map((id) => {
			const shape = editor.getShape(id)!
			return shape
		})
		.filter((shape) => {
			return (
				shape.type === 'text' ||
				shape.type === 'geo' ||
				shape.type === 'arrow' ||
				shape.type === 'note'
			)
		})
		.sort((a, b) => {
			// top first, then left, based on page position
			const pageBoundsA = editor.getShapePageBounds(a)
			const pageBoundsB = editor.getShapePageBounds(b)

			return pageBoundsA.y === pageBoundsB.y
				? pageBoundsA.x < pageBoundsB.x
					? -1
					: 1
				: pageBoundsA.y < pageBoundsB.y
				? -1
				: 1
		})
		.map((shape) => {
			if (!shape) return null
			// @ts-expect-error
			return shape.props.text ?? null
		})
		.filter((v) => !!v)

	return texts.join('\n')
}

function downloadDataURLAsFile(dataUrl: string, filename: string) {
	const link = document.createElement('a')
	link.href = dataUrl
	link.download = filename
	link.click()
}
